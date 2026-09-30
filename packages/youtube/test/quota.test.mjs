import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {quotaDay,cloudUploadQuota,uploadVideo} from '../dist/index.js';

test('Pacific quota days follow DST, not a fixed UTC offset',()=>{
  assert.deepEqual(quotaDay(new Date('2026-03-08T12:00:00Z')),{start:'2026-03-08T08:00:00.000Z',resetAt:'2026-03-09T07:00:00.000Z'});
  assert.deepEqual(quotaDay(new Date('2026-11-01T12:00:00Z')),{start:'2026-11-01T07:00:00.000Z',resetAt:'2026-11-02T08:00:00.000Z'});
});
test('Cloud quota absence is unknown; DELTA usage includes pages and its watermark',async()=>{
  assert.equal((await cloudUploadQuota({})).remaining,null);
  const dir=await mkdtemp(join(tmpdir(),'cf-quota-')),file=join(dir,'fixture.json'),original=globalThis.fetch;
  await writeFile(file,JSON.stringify({type:'authorized_user',client_id:'fixture',client_secret:'fixture',refresh_token:'fixture'}));
  let missing=false;
  globalThis.fetch=async input=>{
    const url=new URL(String(input));
    if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});
    if(url.hostname==='serviceusage.googleapis.com')return Response.json({metrics:[{metric:'youtube.googleapis.com/videos_insert',displayName:'Video uploads',consumerQuotaLimits:[{unit:'1/d/{project}',quotaBuckets:[{effectiveLimit:'100'}]}]}]});
    assert.equal(url.hostname,'monitoring.googleapis.com');
    return Response.json(missing?{}:{timeSeries:[{metricKind:'DELTA',points:[{value:{int64Value:'7'},interval:{endTime:'2026-09-30T11:50:00Z'}}]}]});
  };
  try{
    const env={GOOGLE_CLOUD_PROJECT:'test-project',GOOGLE_APPLICATION_CREDENTIALS:file};
    let q=await cloudUploadQuota(env,new Date('2026-09-30T12:00:00Z'));
    assert.equal(q.state,'ok');assert.equal(q.used,7);assert.equal(q.remaining,93);assert.equal(q.usageThrough,'2026-09-30T11:50:00Z');
    missing=true;q=await cloudUploadQuota(env);assert.equal(q.limit,100);assert.equal(q.remaining,null);assert.equal(q.state,'unavailable');
  }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});
test('progress cannot consume bytes early and a quota rejection sends no upload request',async()=>{
  const original=globalThis.fetch,bytes=Buffer.alloc(90000,42),progress=[];let init=0,admitted=0;
  globalThis.fetch=async(url,options)=>{
    if(options.method==='POST'){init++;return new Response('',{headers:{location:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test'}});}
    await new Promise(r=>setTimeout(r,20));
    assert.deepEqual(Buffer.from(await new Response(options.body).arrayBuffer()),bytes);return Response.json({id:'qa'});
  };
  const opts={title:'Test',description:'',tags:[],privacy:'private'};
  try{
    await uploadVideo('fixture',{...opts,source:{body:Readable.from([bytes.subarray(0,40000),bytes.subarray(40000)]),size:bytes.length},beforeInitiate:async()=>{admitted++;},onProgress:n=>progress.push(n)});
    assert.equal(init,1);assert.equal(admitted,1);assert.equal(progress.at(-1),bytes.length);assert(progress.every((n,i)=>i===0||n>=progress[i-1]));
    await assert.rejects(uploadVideo('fixture',{...opts,source:{body:Readable.from([bytes]),size:bytes.length},beforeInitiate:async()=>{throw Error('[quota-wait]');}}));
    assert.equal(init,1);
  }finally{globalThis.fetch=original;}
});
