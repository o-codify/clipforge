import {open,stat,mkdir,rename,rm} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {pacedStream,waitForResources,resourceRequest,ResourcePauseError} from '@clipforge/resources';

export async function fileDigest(file:string){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
type Request=<T>(path:string,body?:unknown,timeout?:number)=>Promise<T>;
export async function uploadObject(request:Request,file:string,metadata:{name:string;kind:'cache'|'video'|'poster';clipId?:string},kbps:number){
  const info=await stat(file,{bigint:true}),size=Number(info.size),sha256=await fileDigest(file);
  const upload=await request<{id:string;partSize:number;state:string;storageKey:string;parts?:{PartNumber:number;ETag:string;Size:number}[]}>('objects',{...metadata,size,sha256,mtimeNs:info.mtimeNs.toString()});
  if(upload.state==='stored')return {storageKey:upload.storageKey,sha256,size};
  if(upload.partSize!==8*1024*1024)throw new Error('Неверный размер части хранилища');
  const source=await open(file,'r');
  try{for(let offset=0,part=1;offset<size;offset+=upload.partSize,part++){
    await waitForResources();
    const bytes=Buffer.alloc(Math.min(upload.partSize,size-offset));let filled=0;
    while(filled<bytes.length){const {bytesRead}=await source.read(bytes,filled,bytes.length-filled,offset+filled);if(!bytesRead)throw new Error('Файл изменился во время загрузки');filled+=bytesRead;}
    const md5=createHash('md5').update(bytes).digest('base64');
    if(upload.parts?.some(p=>p.PartNumber===part&&p.Size===bytes.length&&p.ETag.replaceAll('"','')===Buffer.from(md5,'base64').toString('hex')))continue;
    for(let attempt=0;;attempt++){
      const {url}=await request<{url:string}>(`objects/${upload.id}/part`,{part,md5});
      try{await resourceRequest(async signal=>{
        const body=pacedStream(Readable.from([bytes]),'upload',kbps*125);
        try{const response=await fetch(url,{method:'PUT',headers:{'content-type':'application/octet-stream','content-md5':md5,'content-length':String(bytes.length)},body:body as never,duplex:'half',signal,redirect:'error'} as RequestInit);
          await response.body?.cancel();if(!response.ok)throw new Error(`S3 upload: ${response.status}`);
        }finally{body.destroy();}
      });break;}catch(error){if(!(error instanceof ResourcePauseError)&&attempt>=3)throw error;await waitForResources();}
    }
  }}finally{await source.close();}
  const after=await stat(file,{bigint:true});
  if(after.size!==info.size||after.mtimeNs!==info.mtimeNs)throw new Error('Файл изменился во время загрузки');
  const result=await request<{storageKey:string}>(`objects/${upload.id}/complete`,{},120000);
  return {...result,sha256,size};
}

export async function downloadObject(url:()=>Promise<string>,file:string,size:number,sha256:string,kbps:number){
  await mkdir(dirname(file),{recursive:true});const pending=file+'.cloud-part';
  for(let attempt=0;;attempt++){
    await waitForResources();let offset=await stat(pending).then(s=>s.size).catch(()=>0);
    if(offset>size){await rm(pending);offset=0;}if(offset===size)break;
    try{await resourceRequest(async signal=>{
      const response=await fetch(await url(),{headers:offset?{range:`bytes=${offset}-`}:{},signal,redirect:'error'});
      if(!response.ok||!response.body||(offset&&!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)))throw new Error('S3 не передало запрошенную часть файла');
      await pipeline(pacedStream(Readable.fromWeb(response.body as never),'download',kbps*125),createWriteStream(pending,{flags:offset?'a':'w'}),{signal});
    });}catch(error){if(!(error instanceof ResourcePauseError)&&attempt>=3)throw error;}
  }
  if((await stat(pending)).size!==size||await fileDigest(pending)!==sha256){await rm(pending,{force:true});throw new Error('Контрольная сумма исходника не совпала');}
  await rename(pending,file);
}
