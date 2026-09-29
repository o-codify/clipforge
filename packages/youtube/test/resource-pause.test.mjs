import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { uploadVideo } from '../dist/index.js';

test('foreground pause resumes the same YouTube session from server-confirmed offset',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'clipforge-youtube-'));
  const originalFetch=globalThis.fetch,previous=process.env.MEDIA_RESOURCE_STATE;
  process.env.MEDIA_RESOURCE_STATE=join(dir,'state.json');
  const state=paused=>writeFile(process.env.MEDIA_RESOURCE_STATE,JSON.stringify({at:Date.now(),paused,uploadKbps:100000}));
  const bytes=Buffer.alloc(65536,41),reopened=[];let posts=0,uploads=0,checks=0,saved=0,renewed=0,unpause;
  const session='https://www.googleapis.com/upload/youtube/v3/videos?upload_id=offline-test';
  try{
    await state(false);
    globalThis.fetch=async(url,init)=>{
      if(init.method==='POST'){posts++;return new Response('',{headers:{location:session}});}
      assert.equal(url,session);
      if(init.headers['content-range']===`bytes */${bytes.length}`){checks++;assert.equal(init.headers.authorization,'Bearer renewed-token');return new Response('',{status:308,headers:{range:'bytes=0-16383'}});}
      uploads++;
      if(uploads===1){
        const reader=init.body.getReader();
        const first=await reader.read();assert.equal(first.value.length,16384);reader.releaseLock();
        await state(true);unpause=delay(800).then(()=>state(false));
        await delay(2000,undefined,{signal:init.signal});assert.fail('upload should abort');
      }
      assert.equal(init.headers['content-range'],`bytes 16384-${bytes.length-1}/${bytes.length}`);
      assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()),bytes.subarray(16384));
      return Response.json({id:'offline-video'});
    };
    const id=await uploadVideo('offline-token',{source:{body:Readable.from([bytes]),size:bytes.length,reopen:async offset=>{reopened.push(offset);return Readable.from([bytes.subarray(offset)]);}},
      renewAccessToken:async()=>{renewed++;return 'renewed-token';},
      saveSession:async()=>{saved++;},title:'Test',description:'',tags:[],privacy:'private'});
    await unpause;
    assert.equal(id,'offline-video');assert.deepEqual(reopened,[16384]);
    assert.deepEqual({posts,uploads,checks,saved},{posts:1,uploads:2,checks:1,saved:1});
    assert.equal(renewed,1);
  }finally{
    globalThis.fetch=originalFetch;
    if(previous===undefined)delete process.env.MEDIA_RESOURCE_STATE;else process.env.MEDIA_RESOURCE_STATE=previous;
    await rm(dir,{recursive:true,force:true});
  }
});
