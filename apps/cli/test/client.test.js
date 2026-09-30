import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {PlatformClient} from '../dist/client.js';
import {commandPlan,parseCommand,execute} from '../dist/commands.js';

test('reject insecure remote URLs, session injection and ambiguous commands',async()=>{
  for(const url of ['http://example.org','https://user:password@example.org','https://example.org/path']) assert.throws(()=>new PlatformClient(url));
  assert.throws(()=>new PlatformClient('http://localhost:8420','bad; cookie'));
  await assert.rejects(commandPlan(parseCommand(['refresh','--metadata','file.json'])));
  await assert.rejects(commandPlan(parseCommand(['publish','clip'])));
  await assert.rejects(commandPlan(parseCommand(['refresh','id','extra'])));
  await assert.rejects(commandPlan(parseCommand(['wait','id','--timeout','Infinity'])));
  assert.deepEqual(await commandPlan(parseCommand(['refresh','pub'])),{path:'/api/platforms/youtube/refresh',method:'POST',body:{publicationId:'pub'}});
});

test('DTLN is opt-in for one fresh render; other commands cannot enable audio processing',async()=>{
  assert.deepEqual(await commandPlan(parseCommand(['render','vod'])),
    {path:'/api/jobs/render/vod',method:'POST',body:{count:1}});
  assert.deepEqual(await commandPlan(parseCommand(['render','vod','--fresh','--audio','dtln'])),
    {path:'/api/jobs/render/vod',method:'POST',body:{count:1,skipExisting:true,audioMode:'dtln'}});
  await assert.rejects(commandPlan(parseCommand(['cleanup','clip','--audio','dtln'])));
  await assert.rejects(commandPlan(parseCommand(['render','vod','--audio','unknown'])));
});

test('prepare only requests a bounded draft pipeline and never changes streamer defaults',async()=>{
  assert.deepEqual(await commandPlan(parseCommand(['prepare','vod','--count','6','--audio','dtln'])),
    {path:'/api/jobs/prepare/vod',method:'POST',body:{count:6,audioMode:'dtln'}});
  assert.deepEqual(await commandPlan(parseCommand(['prepare','vod'])),
    {path:'/api/jobs/prepare/vod',method:'POST',body:{count:1}});
  for(const args of [['--count','101'],['--count','0'],['--audio','unknown'],['--metadata','file.json']])
    await assert.rejects(commandPlan(parseCommand(['prepare','vod',...args])));
});

test('mass drafts and independent inherited ad preferences are explicit API operations',async()=>{
  assert.deepEqual(await commandPlan(parseCommand(['prepare-streamer','sany_jeweler','--count','100','--audio','dtln-gated','--vods','v1,v2'])),
    {path:'/api/jobs/prepare-streamer/sany_jeweler',method:'POST',body:{count:100,audioMode:'dtln-gated',vodIds:['v1','v2']}});
  assert.deepEqual(await commandPlan(parseCommand(['streamer-ads','sany_jeweler','--ads','off','--all'])),
    {path:'/api/streamers/sany_jeweler/ads',method:'POST',body:{enabled:false,applyToAll:true}});
  assert.deepEqual(await commandPlan(parseCommand(['vod-ads','v1','--ads','inherit'])),
    {path:'/api/vods/v1/ads',method:'POST',body:{enabled:null}});
  for(const args of [['streamer-ads','sany','--ads','inherit'],['vod-ads','v1','--ads','off','--all'],['prepare-streamer','sany','--vods','v1,v1'],['prepare-streamer','sany','--count','101']])
    await assert.rejects(commandPlan(parseCommand(args)));
});

test('paced publication explicitly scopes one batch and has a separate pause action',async()=>{
  assert.deepEqual(await commandPlan(parseCommand(['pace-batch','batch','--channel','UC-P-55QVYfT8SBtGnCNAtog'])),
    {path:'/api/platforms/batches/batch',method:'POST',body:{enabled:true,channelId:'UC-P-55QVYfT8SBtGnCNAtog',intervalMinutes:10,dailyLimit:100,privacy:'public'}});
  assert.deepEqual(await commandPlan(parseCommand(['pause-batch','batch'])),{path:'/api/platforms/batches/batch',method:'DELETE'});
  await assert.rejects(commandPlan(parseCommand(['pace-batch','batch','--channel','anything'])));
  await assert.rejects(commandPlan(parseCommand(['pace-batch','batch','--channel','UC-P-55QVYfT8SBtGnCNAtog','--daily-limit','101'])));
});

test('login and logout use API; reads do not write; mutations are not retried or redirected',async()=>{
  const calls=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    calls.push({path:req.url,method:req.method,cookie:req.headers.cookie,body:Buffer.concat(chunks).toString()});
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/auth/login')res.setHeader('Set-Cookie','clipforge_session=fixture; HttpOnly; Path=/');
    if(req.url==='/api/fail')res.statusCode=503;
    if(req.url==='/api/redirect'){res.statusCode=302;res.setHeader('Location','/api/leak');}
    res.end(JSON.stringify(req.url==='/api/job'?{state:'failed'}:{ok:true}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    const client=new PlatformClient(url);
    await client.login('qa','secret');
    await client.request('/api/platforms/publications/pub');
    await assert.rejects(client.request('/api/fail','POST',{}));
    await assert.rejects(client.request('/api/redirect'));
    await assert.rejects(client.request('https://example.org/api/anything'));
    assert.equal((await execute(client,{path:'/api/job',waitSeconds:1})).exitCode,1);
    await client.close();
    assert.equal(calls.filter(call=>call.path==='/api/fail').length,1);
    assert.equal(calls.some(call=>call.path==='/api/leak'),false);
    assert.equal(calls[1].method,'GET');assert.equal(calls[1].cookie,'clipforge_session=fixture');
    assert.equal(calls.at(-1).path,'/api/auth/logout');
    const borrowed=new PlatformClient(url,'borrowed');await borrowed.close();
    assert.equal(calls.filter(call=>call.path==='/api/auth/logout').length,1);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
