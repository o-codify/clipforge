import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { uploadVideo, refreshAccessToken, YoutubeAccessRevokedError, revokeToken, validateVideoMetadata } from '../dist/index.js';

test('uploads a private S3 stream with its byte length and closes it on failure', async () => {
  const fetchOriginal=globalThis.fetch;
  const bytes=Buffer.from('prepared-video-content');
  const source=Readable.from([bytes]);
  const options={source:{body:source,size:bytes.length},title:'Test',description:'',tags:[],privacy:'private'};
  let requests=0;
  globalThis.fetch=async (url,init)=>{
    requests++;
    if(requests===1){assert.equal(init.headers['x-upload-content-length'],String(bytes.length));return new Response('',{status:200,headers:{location:'https://www.googleapis.com/test-session'}});}
    assert.equal(init.headers['content-length'],String(bytes.length));
    assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()),bytes);
    return Response.json({id:'test-only-id'});
  };
  try{
    assert.equal(await uploadVideo('test-only-token',options),'test-only-id');
    assert.equal(requests,2);assert(source.destroyed);
    const failed=Readable.from([bytes]);
    globalThis.fetch=async()=>new Response('failed',{status:503});
    await assert.rejects(uploadVideo('test-only-token',{...options,source:{body:failed,size:bytes.length}}));
    assert(failed.destroyed);
  }finally{globalThis.fetch=fetchOriginal;}
});

test('preserves complete uploader metadata and rejects invalid input before sending',async()=>{
  const original=globalThis.fetch;
  const metadata={title:'Ж'.repeat(100),description:'Я'.repeat(2500),privacy:'unlisted'};
  let calls=0;
  globalThis.fetch=async(url,init)=>{
    calls++;
    if(calls===1){const payload=JSON.parse(init.body);assert.equal(payload.snippet.title,metadata.title);assert.equal(payload.snippet.description,metadata.description);assert.equal(payload.status.privacyStatus,'unlisted');return new Response('',{headers:{location:'https://www.googleapis.com/test-session'}});}
    await new Response(init.body).arrayBuffer();return Response.json({id:'test-id'});
  };
  try{
    await uploadVideo('test-token',{...metadata,tags:[],source:{body:Readable.from([Buffer.from('x')]),size:1}});
    assert.equal(calls,2);
    assert.throws(()=>validateVideoMetadata({...metadata,title:'x'.repeat(101)}));
    assert.throws(()=>validateVideoMetadata({...metadata,description:metadata.description+'x'}));
    assert.throws(()=>validateVideoMetadata({...metadata,title:'<title>'}));
    const invalid=Readable.from([Buffer.from('x')]);
    await assert.rejects(uploadVideo('test-token',{...metadata,title:' ',tags:[],source:{body:invalid,size:1}}));
    assert(invalid.destroyed);assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
});

test('distinguishes withdrawn consent from outages and revokes without leaking tokens',async()=>{
  const original=globalThis.fetch;
  const app={clientId:'test',clientSecret:'test'};
  try{
    globalThis.fetch=async()=>Response.json({error:'invalid_grant'},{status:400});
    await assert.rejects(refreshAccessToken(app,'secret-token'),YoutubeAccessRevokedError);
    globalThis.fetch=async()=>new Response('secret-token',{status:503});
    await assert.rejects(refreshAccessToken(app,'secret-token'),error=>!(error instanceof YoutubeAccessRevokedError)&&!error.message.includes('secret-token'));
    globalThis.fetch=async(url,init)=>{assert.equal(url,'https://oauth2.googleapis.com/revoke');assert.equal(new URLSearchParams(init.body).get('token'),'secret-token');return new Response('');};
    await revokeToken('secret-token');
    globalThis.fetch=async()=>Response.json({error:'invalid_token'},{status:400});await revokeToken('already-revoked');
    globalThis.fetch=async()=>new Response('',{status:503});await assert.rejects(revokeToken('retry-this'));
  }finally{globalThis.fetch=original;}
});
