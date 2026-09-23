import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { uploadVideo } from '../dist/index.js';

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
