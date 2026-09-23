import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class MediaStorage {
  constructor(readonly client: S3Client, readonly bucket: string, readonly prefix: string) {}

  key(clipId: string, asset: "video.mp4" | "poster.jpg") {
    if (!/^[a-zA-Z0-9._-]+$/.test(clipId)) throw new Error("Invalid clip ID");
    return `${this.prefix}/clips/${clipId}/${asset}`;
  }

  private checkKey(key: string) {
    if (!key.startsWith(`${this.prefix}/`) || key.includes("..")) throw new Error("Object is outside the ClipForge namespace");
  }

  async uploadFile(key: string, file: string, contentType: string): Promise<void> {
    this.checkKey(key);
    const size = (await stat(file)).size;
    if (!size) throw new Error("Cannot upload an empty media file");
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: contentType,
    }));
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    if (head.ContentLength !== size) throw new Error("Stored object size differs from the local file");
  }

  async readUrl(key: string, expiresIn = 300): Promise<string> {
    this.checkKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  async removeProbe(key: string): Promise<void> {
    if (!key.startsWith(`${this.prefix}/checks/`)) throw new Error("Only a temporary check object can be removed here");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): MediaStorage | null {
  if (!env.S3_ENDPOINT && !env.S3_BUCKET) return null;
  const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required`); return value; };
  const endpoint = required("S3_ENDPOINT");
  if (new URL(endpoint).protocol !== "https:") throw new Error("S3_ENDPOINT must use HTTPS");
  const prefix = (env.S3_PREFIX || "clipforge").replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw new Error("Invalid S3_PREFIX");
  return new MediaStorage(new S3Client({
    endpoint, region: required("S3_REGION"), forcePathStyle: true,
    credentials: { accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY") },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
  }), required("S3_BUCKET"), prefix);
}
