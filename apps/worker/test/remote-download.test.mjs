import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RemoteClient,RemoteTaskAccess} from '../dist/remote-client.js';

test('source download validates catalogued bytes even when a proxy strips Content-Length',async()=>{
  const bytes=Buffer.from('a complete video fixture');let truncated=false;
  const server=createServer((req,res)=>{
    if(req.url.endsWith('/operation')){res.setHeader('content-type','application/json');res.end(JSON.stringify({clip:{sizeBytes:bytes.length}}));return;}
    res.write(bytes.subarray(0,8));res.end(truncated?undefined:bytes.subarray(8));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=await mkdtemp(join(tmpdir(),'clipforge-download-'));
  try{
    const access=new RemoteTaskAccess(new RemoteClient({origin:`http://127.0.0.1:${server.address().port}`,secret:'fixture',workerId:'fixture'}),{leaseId:'fixture',policy:{downloadKbps:10000}});
    await access.downloadClip('fixture',join(dir,'complete.mp4'));
    assert.deepEqual(await readFile(join(dir,'complete.mp4')),bytes);
    truncated=true;
    await assert.rejects(access.downloadClip('fixture',join(dir,'broken.mp4')),/Клип передан не полностью/);
    await assert.rejects(stat(join(dir,'broken.mp4')), {code:'ENOENT'});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
