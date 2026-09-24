import '../dist/context.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { storageFromEnv } from '@clipforge/storage';

const storage=storageFromEnv();
assert(storage,'S3 configuration required');
let writes=0;
const send=storage.client.send.bind(storage.client);
storage.client.send=async command=>{
  if(command.constructor.name==='PutObjectCommand')writes++;
  return send(command);
};
const key=`${storage.prefix}/checks/${randomUUID()}.txt`;
const file=join(tmpdir(),`clipforge-storage-${randomUUID()}.txt`);
const payload=`ClipForge storage check ${randomUUID()}`;
try {
  await writeFile(file,payload);
  await storage.uploadFile(key,file,'text/plain');
  await storage.uploadFile(key,file,'text/plain');
  assert.equal(writes,1,'A retry of the same file must not upload it twice');
  const resumed=await storage.openVideoRange(key,9);
  const chunks=[];
  for await(const chunk of resumed)chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(),payload.slice(9),'Resumed bytes must match the original');
  const url=await storage.readUrl(key,60);
  const range=await fetch(url,{headers:{Range:'bytes=0-8'},signal:AbortSignal.timeout(15000)});
  assert.equal(range.status,206,'S3 must support seeking');
  assert.equal(await range.text(),payload.slice(0,9));
  const full=await fetch(url,{signal:AbortSignal.timeout(15000)});
  assert.equal(await full.text(),payload);
  const unsigned=new URL(url); unsigned.search='';
  const anonymous=await fetch(unsigned,{signal:AbortSignal.timeout(15000)});
  assert([401,403,404].includes(anonymous.status),'Bucket is public: clips would bypass platform permissions');
  console.log('PASS: Beget S3 verified upload, duplicate skipped, resumed bytes, signed reads and anonymous access denied');
} finally {
  await storage.removeProbe(key);
  await unlink(file).catch(()=>{});
  storage.client.destroy();
}
