import { createReadStream, createWriteStream } from "node:fs";
import { stat, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { pacedStream, waitForResources, resourceRequest, ResourcePauseError } from '@clipforge/resources';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class MediaStorage {
  constructor(readonly client: S3Client, readonly bucket: string, readonly prefix: string, readonly bytesPerSecond=0) {}

  key(clipId: string, asset: "video.mp4" | "poster.jpg") {
    if (!/^[a-zA-Z0-9._-]+$/.test(clipId)) throw new Error("Invalid clip ID");
    return `${this.prefix}/clips/${clipId}/${asset}`;
  }

  private checkKey(key: string) {
    if (!key.startsWith(`${this.prefix}/`) || key.includes("..")) throw new Error("Object is outside the ClipForge namespace");
  }

  async head(key:string,timeoutMs?:number) {
    this.checkKey(key);
    return this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:key}),timeoutMs?{abortSignal:AbortSignal.timeout(timeoutMs)}:undefined).catch(error=>{
      if(error.$metadata?.httpStatusCode===404)return null;throw error;
    });
  }
  async beginMultipart(key:string,sha256:string,contentType:string) {
    this.checkKey(key);
    const result=await this.client.send(new CreateMultipartUploadCommand({Bucket:this.bucket,Key:key,ContentType:contentType,Metadata:{sha256}}));
    if(!result.UploadId)throw new Error('S3 did not create an upload');return result.UploadId;
  }
  async partUrl(key:string,uploadId:string,part:number,length:number,md5:string) {
    this.checkKey(key);
    return getSignedUrl(this.client,new UploadPartCommand({Bucket:this.bucket,Key:key,UploadId:uploadId,PartNumber:part,ContentLength:length,ContentMD5:md5}),{expiresIn:900});
  }
  async finishMultipart(key:string,uploadId:string,size:number,sha256:string,partSize:number) {
    this.checkKey(key);
    const existing=await this.head(key);
    if(existing?.ContentLength===size&&existing.Metadata?.sha256===sha256)return;
    const parts=await this.multipartParts(key,uploadId);
    const count=Math.ceil(size/partSize);
    if(parts.length!==count||parts.some((p,i)=>p.PartNumber!==i+1||p.Size!==Math.min(partSize,size-i*partSize)))throw new Error('S3 upload is incomplete');
    await this.client.send(new CompleteMultipartUploadCommand({Bucket:this.bucket,Key:key,UploadId:uploadId,MultipartUpload:{Parts:parts.map(({PartNumber,ETag})=>({PartNumber,ETag}))}}));
    const head=await this.head(key);
    if(head?.ContentLength!==size||head.Metadata?.sha256!==sha256)throw new Error('Stored object verification failed');
  }
  async multipartParts(key:string,uploadId:string){
    this.checkKey(key);
    const parts:{PartNumber:number;ETag:string;Size:number}[]=[];
    let marker:string|undefined;
    do {
      const response=await this.client.send(new ListPartsCommand({Bucket:this.bucket,Key:key,UploadId:uploadId,PartNumberMarker:marker}));
      for(const part of response.Parts??[]) {
        if(!part.PartNumber||!part.ETag||!part.Size)throw new Error('Incomplete S3 part');
        parts.push({PartNumber:part.PartNumber,ETag:part.ETag,Size:part.Size});
      }
      marker=response.IsTruncated?response.NextPartNumberMarker:undefined;
      if(response.IsTruncated&&!marker)throw new Error('Invalid S3 pagination');
    }while(marker);
    return parts;
  }
  async abortMultipart(key:string,uploadId:string) {
    this.checkKey(key);
    await this.client.send(new AbortMultipartUploadCommand({Bucket:this.bucket,Key:key,UploadId:uploadId})).catch(error=>{if(error.$metadata?.httpStatusCode!==404)throw error;});
  }

  async uploadFile(key: string, file: string, contentType: string): Promise<void> {
    await waitForResources();
    this.checkKey(key);
    const size = (await stat(file)).size;
    if (!size) throw new Error("Cannot upload an empty media file");
    const hash=createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const sha256=hash.digest('hex');
    const existing=await this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:key})).catch(error=>{
      if(error.$metadata?.httpStatusCode===404)return null;
      throw error;
    });
    if(existing?.ContentLength===size && existing.Metadata?.sha256===sha256)return;
    for (;;) {
    const body = pacedStream(createReadStream(file,{highWaterMark:16384}), 'upload', this.bytesPerSecond);
    try {
    await resourceRequest(signal=>this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key,
      Body: body,
      ContentLength: size, ContentType: contentType,
      Metadata:{sha256},
    }),{abortSignal:signal}));
    break;
    } catch(error) { if (!(error instanceof ResourcePauseError))throw error; }
    finally {body.destroy();}
    }
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    if (head.ContentLength !== size || head.Metadata?.sha256!==sha256) throw new Error("Stored object differs from the local file");
  }

  async readUrl(key: string, expiresIn = 300): Promise<string> {
    this.checkKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  /** Desktop downloads checkpoint bytes and close sockets during activity. */
  async downloadFile(key:string,file:string):Promise<void> {
    this.checkKey(key);
    await waitForResources();
    const head=await this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:key}));
    const size=head.ContentLength;
    if(!size)throw new Error('Stored video is empty');
    const pending=`${file}.part`;
    for (;;) {
      let offset=await stat(pending).then(s=>s.size).catch(()=>0);
      if(offset>size){await rm(pending);offset=0;}
      if(offset===size)break;
      try {
        await resourceRequest(async signal=>{
          const object=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key,
            ...(offset ? {Range:`bytes=${offset}-`} : {}),IfMatch:head.ETag}),{abortSignal:signal});
          if(!(object.Body instanceof Readable) || (offset && !object.ContentRange?.startsWith(`bytes ${offset}-`)))throw new Error('Stored video range is unavailable');
          await pipeline(pacedStream(object.Body,'download'),createWriteStream(pending,{flags:offset?'a':'w'}),{signal});
        });
      } catch(error) {if(!(error instanceof ResourcePauseError))throw error;}
    }
    if(head.Metadata?.sha256) {
      const hash=createHash('sha256');
      for await(const chunk of createReadStream(pending))hash.update(chunk);
      if(hash.digest('hex')!==head.Metadata.sha256){await rm(pending);throw new Error('Downloaded video checksum differs');}
    }
    await rename(pending,file);
  }

  async openVideo(key: string): Promise<{ body: Readable; size: number }> {
    await waitForResources();
    this.checkKey(key);
    const object = await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}));
    if (!(object.Body instanceof Readable) || !object.ContentLength) throw new Error('Stored video is empty or unreadable');
    return {body:process.env.MEDIA_RESOURCE_STATE ? pacedStream(object.Body,'download') : object.Body,size:object.ContentLength};
  }

  async openVideoRange(key:string,offset:number):Promise<Readable> {
    await waitForResources();
    this.checkKey(key);
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid media offset');
    const object=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key,Range:`bytes=${offset}-`}));
    if(!(object.Body instanceof Readable) || !object.ContentRange?.startsWith(`bytes ${offset}-`))throw new Error('Stored video range is unavailable');
    return process.env.MEDIA_RESOURCE_STATE ? pacedStream(object.Body,'download') : object.Body;
  }

  async removeProbe(key: string): Promise<void> {
    if (!key.startsWith(`${this.prefix}/checks/`)) throw new Error("Only a temporary check object can be removed here");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async *mediaObjects() {
    for(const kind of ['clips','sources']) {
      let token:string|undefined;
      do {
        const page=await this.client.send(new ListObjectsV2Command({Bucket:this.bucket,Prefix:`${this.prefix}/${kind}/`,ContinuationToken:token}));
        for(const object of page.Contents??[])if(object.Key)yield {key:object.Key,size:object.Size??0,modified:object.LastModified??new Date()};
        token=page.IsTruncated?page.NextContinuationToken:undefined;
      }while(token);
    }
  }
  async removeMedia(key:string) {
    this.checkKey(key);
    if(!['clips','sources'].some(kind=>key.startsWith(`${this.prefix}/${kind}/`)))throw new Error('Only generated media can be removed');
    await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:key}));
  }
}

export * from './local-cache.js';

export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): MediaStorage | null {
  if (!env.S3_ENDPOINT && !env.S3_BUCKET) return null;
  const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required`); return value; };
  const endpoint = required("S3_ENDPOINT");
  if (new URL(endpoint).protocol !== "https:") throw new Error("S3_ENDPOINT must use HTTPS");
  const prefix = (env.S3_PREFIX || "clipforge").replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw new Error("Invalid S3_PREFIX");
  const kbps=Number(env.MEDIA_UPLOAD_KBPS || env.MEDIA_NETWORK_KBPS || (env.WORKER_ROLE==='media' ? 5000 : 0));
  if(!Number.isFinite(kbps)||kbps<0||kbps>40000)throw new Error('Invalid MEDIA_NETWORK_KBPS');
  return new MediaStorage(new S3Client({
    endpoint, region: required("S3_REGION"), forcePathStyle: true,
    credentials: { accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY") },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
  }), required("S3_BUCKET"), prefix, Math.floor(kbps*1000/8));
}
