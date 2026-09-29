import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaStorage } from '../dist/index.js';

async function fixture(run) {
  const dir=await mkdtemp(join(tmpdir(),'clipforge-transfer-'));
  const previous=process.env.MEDIA_RESOURCE_STATE;
  process.env.MEDIA_RESOURCE_STATE=join(dir,'resources.json');
  const state=paused=>writeFile(process.env.MEDIA_RESOURCE_STATE,JSON.stringify({at:Date.now(),paused,downloadKbps:100000,uploadKbps:100000}));
  try {await state(false);await run(dir,state);}
  finally {if(previous===undefined)delete process.env.MEDIA_RESOURCE_STATE;else process.env.MEDIA_RESOURCE_STATE=previous;await rm(dir,{recursive:true,force:true});}
}

test('download closes on foreground activity and resumes only remaining confirmed bytes',()=>fixture(async(dir,state)=>{
  const bytes=Buffer.alloc(65536,37),hash=createHash('sha256').update(bytes).digest('hex');
  const ranges=[];let attempts=0,unpause;
  const client={send:async(command,options)=>{
    const input=command.input;
    if(command.constructor.name==='HeadObjectCommand')return {ContentLength:bytes.length,ETag:'version-1',Metadata:{sha256:hash}};
    assert.equal(command.constructor.name,'GetObjectCommand');assert.equal(input.IfMatch,'version-1');
    const offset=input.Range?Number(input.Range.match(/\d+/)[0]):0;ranges.push(offset);attempts++;
    if(attempts===1) {
      const body=Readable.from((async function*(){
        yield bytes.subarray(0,16384);
        await delay(80);await state(true);
        unpause=delay(800).then(()=>state(false));
        await delay(2000,undefined,{signal:options.abortSignal});
        yield bytes.subarray(16384);
      })());
      return {Body:body,ContentLength:bytes.length};
    }
    return {Body:Readable.from([bytes.subarray(offset)]),ContentRange:`bytes ${offset}-${bytes.length-1}/${bytes.length}`};
  }};
  await new MediaStorage(client,'test','clipforge').downloadFile('clipforge/clips/test/video.mp4',join(dir,'video.mp4'));
  await unpause;
  assert.equal(attempts,2);assert.deepEqual(ranges,[0,16384]);
  assert.deepEqual(await readFile(join(dir,'video.mp4')),bytes);
}));

test('upload pause retries the same immutable key and verifies its checksum',()=>fixture(async(dir,state)=>{
  const file=join(dir,'video.mp4'),bytes=Buffer.alloc(65536,23);await writeFile(file,bytes);
  let stored,attempts=0,unpause;const keys=[];
  const client={send:async(command,options)=>{
    if(command.constructor.name==='HeadObjectCommand'){
      if(!stored)throw {$metadata:{httpStatusCode:404}};
      return {ContentLength:stored.body.length,Metadata:stored.metadata};
    }
    assert.equal(command.constructor.name,'PutObjectCommand');
    keys.push(command.input.Key);attempts++;
    if(attempts===1){
      await state(true);unpause=delay(800).then(()=>state(false));
      await delay(2000,undefined,{signal:options.abortSignal});
      assert.fail('request must be aborted');
    }
    const chunks=[];for await(const chunk of command.input.Body)chunks.push(chunk);
    stored={body:Buffer.concat(chunks),metadata:command.input.Metadata};
    return {};
  }};
  const storage=new MediaStorage(client,'test','clipforge');
  await storage.uploadFile('clipforge/clips/test/video.mp4',file,'video/mp4');await unpause;
  assert.deepEqual(keys,['clipforge/clips/test/video.mp4','clipforge/clips/test/video.mp4']);
  assert.deepEqual(stored.body,bytes);
  await storage.uploadFile('clipforge/clips/test/video.mp4',file,'video/mp4');
  assert.equal(attempts,2,'matching object is not uploaded again');
}));
