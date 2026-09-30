import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,cp,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import Fastify from 'fastify';
import {createDatabase,upgradeRuntime,streamers,vods,runs,clips,withVodLock} from '../../../packages/db/dist/index.js';
import {QUEUES} from '../../../packages/jobs/dist/index.js';
import {segmentKey,clipId} from '../../../packages/pipeline/dist/index.js';
import {WorkerGatewayService} from '../dist/worker-gateway.service.js';
import {JobsService} from '../dist/jobs/jobs.service.js';
import {AuthGuard} from '../dist/auth/auth.guard.js';
import {WorkersController} from '../dist/workers.controller.js';
import {Reflector} from '@nestjs/core';

const adminUrl=new URL(process.env.CLIPFORGE_TEST_DB_URL??'postgres://clipforge:clipforge@127.0.0.1:55432/postgres');
assert(['127.0.0.1','localhost'].includes(adminUrl.hostname));assert(['5432','55432'].includes(adminUrl.port),'Never use production tunnel');
const name='clipforge_remote_qa_'+randomUUID().replaceAll('-',''),url=new URL(adminUrl);url.pathname='/'+name;
const admin=createDatabase({url:adminUrl.href,max:2}),folder=resolve('data/reviews/remote-qa/'+name);
let db,gateway,jobs,server,created=false;const containers=[],volumes=[];
const check=async(condition,ms=20000)=>{const end=Date.now()+ms;while(!await condition()){if(Date.now()>end)throw Error('Timed out');await delay(250);}};
const docker=async(...args)=>(await promisify(execFile)('docker',args,{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:2*1024**2})).stdout.trim();
try{
  await admin.sql.unsafe('create database "'+name+'"');created=true;
  execFileSync(process.execPath,['packages/db/dist/migrate.js'],{env:{...process.env,DATABASE_URL:url.href},windowsHide:true,stdio:'pipe'});
  db=createDatabase({url:url.href,max:10});await upgradeRuntime(db);
  const config={databaseUrl:url.href,port:0,data:folder,out:join(folder,'out'),assets:'assets/twitch',videoFormat:'720p60',clipsPerRun:10,languages:['ru'],youtube:null,apiOrigin:'http://localhost',webOrigin:'http://localhost'};
  jobs=new JobsService(config,db);gateway=new WorkerGatewayService(db,config,jobs);
  // Isolated storage sink. No request in this test may access the production S3 configuration.
  gateway.storage={prefix:'fixture',uploadFile:async(key,file)=>{const target=join(folder,'objects',key);await mkdir(resolve(target,'..'),{recursive:true});await cp(file,target);},openVideo:async key=>{const file=join(folder,'objects',key);return {body:createReadStream(file),size:(await stat(file)).size};}};
  const login='fixture';await db.insert(streamers).values({login,adCheckEnabled:false});
  const ids=['v90000001','v90000002','v90000003','v90000004','v90000005','v90000006'];
  for(const id of ids)await db.insert(vods).values({id,streamer:login,duration:120});
  const resources={allocation:{cpus:2,memoryMb:8192,usedMb:128},freeGb:100,paused:false};
  const register=async()=>{const connection=await gateway.connect({label:'QA'}),key=connection.command.split(' ').at(-1),secret=randomBytes(32).toString('base64url');
    assert(!/env-file|DATABASE_URL|S3_|docker login/.test(connection.command));
    assert(connection.command.includes('--cpus=2 '));assert(connection.command.includes('--memory=6144m '));
    const worker=await gateway.enroll({key,secret,host:'qa'});assert.deepEqual(await gateway.enroll({key,secret,host:'qa'}),worker);
    await assert.rejects(gateway.enroll({key,secret:randomBytes(32).toString('base64url'),host:'qa'}));
    const auth='Bearer '+secret;await gateway.heartbeat(auth,{resources,leaseId:null,version:'fixture'});return {...worker,auth};};
  await assert.rejects(gateway.connect({label:'QA',policy:{cpu:128,memoryGb:256}}));
  const [a,b]=await Promise.all([register(),register()]);
  assert.deepEqual(a.policy,{profile:'media',cpu:2,memoryGb:6,downloadKbps:10000,uploadKbps:5000});
  await assert.rejects(gateway.enroll({key:randomBytes(32).toString('base64url'),secret:randomBytes(32).toString('base64url'),host:'qa'}));
  await assert.rejects(gateway.next('Bearer '+randomBytes(32).toString('base64url')));
  for(const viewer of [null,{isAdmin:false,role:'user'},{isAdmin:false,role:'admin',isPreview:true}]){
    const context={getHandler:()=>WorkersController.prototype.connect,getClass:()=>WorkersController,switchToHttp:()=>({getRequest:()=>({method:'POST',url:'/api/workers/connect',cookies:{}})})};
    await assert.rejects(new AuthGuard({viewerFor:async()=>viewer},new Reflector()).canActivate(context));
  }
  const j1=await jobs.enqueue(QUEUES.analyzeVod,{vodId:ids[0]}),j2=await jobs.enqueue(QUEUES.analyzeVod,{vodId:ids[1]}),j3=await jobs.enqueue(QUEUES.facecamVod,{vodId:ids[0]});
  let [t1,t2]=await Promise.all([gateway.next(a.auth),gateway.next(b.auth)]);t1??=await gateway.next(a.auth);t2??=await gateway.next(b.auth);assert(t1&&t2);assert.notEqual(t1.payload.vodId,t2.payload.vodId);assert.notEqual(t1.jobId,t2.jobId);
  assert.equal(await gateway.next(a.auth),null);
  const serialized=JSON.stringify(t1);assert(!/database|password|secret|credentials|s3_/i.test(serialized));
  await assert.rejects(gateway.operation(b.auth,t1.leaseId,{operation:'vod.get'}));
  await assert.rejects(gateway.operation(a.auth,t1.leaseId,{operation:'sql',input:{query:'select * from platform_accounts'}}));
  assert.equal((await gateway.operation(a.auth,t1.leaseId,{operation:'vod.get',input:{vodId:'other'}})).id,t1.payload.vodId);
  const attempt=await gateway.beginUpload(a.auth,t1.leaseId,{clipId:t1.payload.vodId+'_probe',kind:'video',size:8,sha256:createHash('sha256').update('abcdefgh').digest('hex')});
  await assert.rejects(gateway.beginUpload(a.auth,t1.leaseId,{clipId:'../../etc',kind:'video',size:8,sha256:'a'.repeat(64)}));
  await assert.rejects(gateway.chunk(a.auth,t1.leaseId,attempt.id,{offset:1,data:Buffer.from('abcd').toString('base64')}));
  const part={offset:0,data:Buffer.from('abcd').toString('base64')};assert.equal((await gateway.chunk(a.auth,t1.leaseId,attempt.id,part)).received,4);
  assert.equal((await gateway.chunk(a.auth,t1.leaseId,attempt.id,part)).received,4);
  await assert.rejects(gateway.chunk(a.auth,t1.leaseId,attempt.id,{offset:0,data:Buffer.from('xxxx').toString('base64')}));
  await gateway.chunk(a.auth,t1.leaseId,attempt.id,{offset:4,data:Buffer.from('efgh').toString('base64')});
  const asset=await gateway.commitUpload(a.auth,t1.leaseId,attempt.id);assert.equal(asset.state,'stored');
  await gateway.progress(a.auth,t1.leaseId,{messages:['Обработка звука']});
  // Live lease excludes a native worker too, without assigning its job prematurely.
  let nativeEntered=false;const native=withVodLock(db,t1.payload.vodId,async()=>{nativeEntered=true;});await delay(100);assert.equal(nativeEntered,false);
  await gateway.finish(a.auth,t1.leaseId,{ok:true,output:{frames:12}});await native;assert(nativeEntered);
  assert.deepEqual(await gateway.finish(a.auth,t1.leaseId,{ok:true}),{accepted:true});
  await gateway.finish(b.auth,t2.leaseId,{ok:true});
  const t3=await gateway.next(a.auth);assert.equal(t3.jobId,j3.id);
  await db.sql`update remote_worker_leases set expires_at=now()-interval '1 second' where id=${t3.leaseId}`;
  await gateway.sweep();await db.sql`update jobs.job set start_after=now()-interval '1 second' where id=${t3.jobId}`;
  const takeover=await gateway.next(b.auth);assert.equal(takeover.jobId,t3.jobId);assert.notEqual(takeover.leaseId,t3.leaseId);
  await assert.rejects(gateway.operation(a.auth,t3.leaseId,{operation:'vod.state',input:{state:'ready'}}));
  await assert.rejects(gateway.finish(a.auth,t3.leaseId,{ok:true}));
  await gateway.revoke(b.workerId);await assert.rejects(gateway.operation(b.auth,takeover.leaseId,{operation:'vod.get'}));
  await db.sql`update jobs.job set state='cancelled' where state in ('retry','created','active')`;
  // The server owns catalog settings and only accepts assets from this lease.
  await jobs.enqueue(QUEUES.pipeline,{vodId:ids[5]});const rendering=await gateway.next(a.auth);assert(rendering);
  const operation=(operation,input)=>gateway.operation(a.auth,rendering.leaseId,{operation,input});
  await operation('render.begin',{id:'render-fixture',candidates:1,version:'fixture',settings:{jobId:'forged',audioMode:'dtln',testBatch:false}});
  const segment=segmentKey(ids[5],10,20),renderedId=clipId(ids[5],segment,'fixture');
  const proof={protection:{ads:{automatic:true,reject:false},audio:{method:'original'}}};
  const clip={id:renderedId,runId:'render-fixture',vodId:ids[5],streamer:login,game:null,segmentKey:segment,version:'fixture',file:'clip.mp4',mediaStorage:{videoKey:'forged'},state:'ready',trigger:'fixture',peak:15,start:10,end:20,duration:10,score:1,parts:{},keywords:[],text:'',width:270,height:480,fps:10,sizeBytes:8};
  await assert.rejects(operation('clip.save',{clip,proof}));
  for(const kind of ['video','poster']){const upload=await gateway.beginUpload(a.auth,rendering.leaseId,{clipId:renderedId,kind,size:8,sha256:createHash('sha256').update('abcdefgh').digest('hex')});await gateway.chunk(a.auth,rendering.leaseId,upload.id,{offset:0,data:Buffer.from('abcdefgh').toString('base64')});await gateway.commitUpload(a.auth,rendering.leaseId,upload.id);}
  await assert.rejects(operation('clip.save',{clip:{...clip,streamer:'other'},proof}));
  assert.deepEqual(await operation('clip.save',{clip,proof}),{saved:true});
  const [saved]=await db.sql`select c.state,c.media_storage,r.settings from clips c join runs r on r.id=c.run_id where c.id=${renderedId}`;
  assert.equal(saved.state,'ready');assert.equal(saved.settings.jobId,rendering.jobId);assert.equal(saved.settings.audioMode,'original');assert.notEqual(saved.mediaStorage.videoKey,'forged');
  await operation('render.finish',{runId:'render-fixture'});await gateway.finish(a.auth,rendering.leaseId,{ok:true});
  // Small workers cannot receive heavy jobs or access media/catalog outside their lease.
  const special=async(profile,memoryMb)=>{
    const c=await gateway.connect({label:profile,profile}),secret=randomBytes(32).toString('base64url');
    const w=await gateway.enroll({key:c.command.split(' ').at(-1),secret,host:'qa'}),auth='Bearer '+secret;
    await gateway.heartbeat(auth,{resources:{...resources,allocation:{cpus:.25,memoryMb,usedMb:50},freeGb:1},leaseId:null,version:'fixture'});
    return {...w,auth};
  };
  const catalog=await special('catalog',256),catalog2=await special('catalog',256);
  await jobs.enqueue(QUEUES.transcribeVod,{vodId:ids[0]});
  assert.equal(await gateway.next(catalog.auth),null);
  const index=await jobs.enqueue(QUEUES.indexChannel,{login,limit:10});
  const indexed=await gateway.next(catalog.auth);assert.equal(indexed.jobId,index.id);
  assert.equal(await gateway.next(catalog2.auth),null);
  await assert.rejects(gateway.operation(catalog.auth,indexed.leaseId,{operation:'transcript.get'}));
  await assert.rejects(gateway.beginUpload(catalog.auth,indexed.leaseId,{clipId:ids[0]+'_bad',kind:'video',size:8,sha256:'a'.repeat(64)}));
  const catalogCall=(operation,input)=>gateway.operation(catalog.auth,indexed.leaseId,{operation,input});
  await assert.rejects(catalogCall('catalog.save',{id:ids[0],login:'other',title:'bad',duration:1,publishedAt:null,game:'',chapters:[]}));
  assert.equal((await catalogCall('catalog.save',{id:'v90000999',login,title:'New archive',duration:30,publishedAt:null,game:'Dota 2',chapters:[]})).added,true);
  await catalogCall('catalog.finish');await gateway.finish(catalog.auth,indexed.leaseId,{ok:true});
  // Media workers yield a speech job to an idle speech specialist.
  const speech=await special('speech',6144);
  await gateway.heartbeat(speech.auth,{resources:{...resources,allocation:{cpus:2,memoryMb:6144,usedMb:50}},leaseId:null,version:'fixture'});
  assert.equal(await gateway.next(a.auth),null);
  const spoken=await gateway.next(speech.auth);assert.equal(spoken.queue,QUEUES.transcribeVod);
  await gateway.finish(speech.auth,spoken.leaseId,{ok:true});await gateway.revoke(speech.workerId);
  // Original sound results are immutable and limited to the selected source clips.
  await jobs.enqueue(QUEUES.restoreAudio,{vodId:ids[5],clipIds:[renderedId]});
  const restore=await gateway.next(a.auth);assert.equal(restore.queue,QUEUES.restoreAudio);
  const version=createHash('sha256').update('original-audio-v1:'+renderedId).digest('hex').slice(0,12),newId=renderedId+'_original_'+version;
  const restoration={sourceClipId:renderedId,id:newId,version,runId:'restored-fixture',file:'clip.mp4',sizeBytes:8};
  await assert.rejects(gateway.operation(a.auth,restore.leaseId,{operation:'original-audio.save',input:restoration}));
  for(const kind of ['video','poster']){const upload=await gateway.beginUpload(a.auth,restore.leaseId,{clipId:newId,kind,size:8,sha256:createHash('sha256').update('abcdefgh').digest('hex')});await gateway.chunk(a.auth,restore.leaseId,upload.id,{offset:0,data:Buffer.from('abcdefgh').toString('base64')});await gateway.commitUpload(a.auth,restore.leaseId,upload.id);}
  await gateway.operation(a.auth,restore.leaseId,{operation:'original-audio.save',input:restoration});
  const [restored]=await db.sql`select c.state,r.settings from clips c join runs r on r.id=c.run_id where c.id=${newId}`;
  assert.equal(restored.state,'draft');assert.equal(restored.settings.audioMode,'original');assert.equal(restored.settings.jobId,restore.jobId);
  await gateway.finish(a.auth,restore.leaseId,{ok:true});
  console.log('PASS: tiny catalog isolation, specialty scheduling, immutable original-audio variants');
  // Expired uploads are collected without touching active assignments or assets.
  const abandoned=randomUUID();await mkdir(join(folder,'worker-uploads'),{recursive:true});await writeFile(join(folder,'worker-uploads',abandoned+'.part'),'partial');
  await db.sql`insert into remote_worker_uploads(id,lease_id,clip_id,kind,size,sha256) values(${abandoned},${t3.leaseId},'abandoned','video',7,'unused')`;
  await db.sql`update remote_worker_leases set finished_at=now()-interval '20 minutes' where id=${t3.leaseId}`;
  await gateway.sweep();await assert.rejects(stat(join(folder,'worker-uploads',abandoned+'.part')));
  console.log('PASS: enroll/replay, roles, two independent assignments, VOD isolation, uploads, lease fencing and revocation');
  console.log('PASS: lease-scoped clip assets, server-owned rendering settings and abandoned upload cleanup');

  if(process.env.CLIPFORGE_REMOTE_CONTAINER_TEST==='1'||process.env.CLIPFORGE_REMOTE_CATALOG_TEST==='1'){
    server=Fastify({bodyLimit:8*1024**2,logger:false});
    server.get('/api/worker-gateway/bootstrap',()=>gateway.bootstrap());
    server.post('/api/worker-gateway/enroll',r=>gateway.enroll(r.body));
    server.get('/api/worker-gateway/manifest',r=>gateway.manifest(r.headers.authorization));
    server.get('/api/worker-gateway/bundle',async(r,reply)=>{const file=await gateway.bundle(r.headers.authorization);reply.header('content-length',(await stat(file)).size);return reply.send(createReadStream(file));});
    for(const action of ['installation','heartbeat'])server.post('/api/worker-gateway/'+action,r=>gateway[action](r.headers.authorization,r.body));
    server.post('/api/worker-gateway/next',r=>gateway.next(r.headers.authorization));
    for(const action of ['operation','progress','finish'])server.post('/api/worker-gateway/tasks/:id/'+action,r=>gateway[action](r.headers.authorization,r.params.id,r.body));
    server.post('/api/worker-gateway/tasks/:id/uploads',r=>gateway.beginUpload(r.headers.authorization,r.params.id,r.body));
    server.post('/api/worker-gateway/tasks/:id/uploads/:upload/chunk',r=>gateway.chunk(r.headers.authorization,r.params.id,r.params.upload,r.body));
    server.post('/api/worker-gateway/tasks/:id/uploads/:upload/commit',r=>gateway.commitUpload(r.headers.authorization,r.params.id,r.params.upload));
    server.get('/api/worker-gateway/tasks/:id/source/:clip',async(r,reply)=>{const media=await gateway.source(r.headers.authorization,r.params.id,r.params.clip);return reply.header('content-length',media.size).send(media.body);});
    server.setErrorHandler((e,r,reply)=>reply.code(e.getStatus?.()??500).send({message:e.message}));
    await server.listen({port:0,host:'0.0.0.0'});config.webOrigin='http://host.docker.internal:'+server.server.address().port;
    if(process.env.CLIPFORGE_REMOTE_CATALOG_TEST==='1'){
      const connection=await gateway.connect({label:'Catalog container',profile:'catalog'}),args=connection.command.match(/(?:[^\s"]+|"[^"]*")+/g).map(x=>x.replace(/^"|"$/g,''));
      const name=args[args.indexOf('--name')+1],mount=args[args.indexOf('--mount')+1];containers.push(name);volumes.push(mount.match(/source=([^,]+)/)[1]);
      args.splice(2,0,'--add-host=host.docker.internal:host-gateway');await docker(...args.slice(1));
      let printed=0;
      await check(async()=>{
        const [w]=await db.sql`select state,resources from worker_instances where label='Catalog container'`;
        if(Date.now()-printed>30000){printed=Date.now();console.log('Catalog bootstrap:',w?.state,w?.resources?.stage);}
        return w?.state==='online';
      },12*60000);
      const state=JSON.parse(await docker('inspect',name))[0];assert.equal(state.RestartCount,0);assert.equal(state.HostConfig.Memory,256*1048576);
      const installed=await docker('exec',name,'/storage/venv/bin/python','-c',"import importlib.util;print(importlib.util.find_spec('faster_whisper'))");assert.equal(installed,'None');
      // Replace only the ephemeral test container's external extractor with deterministic fixtures.
      const fixture="import sys,json\nif '--flat-playlist' in sys.argv: print('v90000001\\tFixture\\t120\\tNA\\thttps://www.twitch.tv/videos/90000001')\nelse: print(json.dumps(dict(id='v90000001',uploader_id='fixture',title='Catalog container result',duration=120,chapters=[])))\n";
      await docker('exec',name,'/storage/venv/bin/python','-c',"import pathlib,yt_dlp;pathlib.Path(yt_dlp.__file__).with_name('__main__.py').write_text("+JSON.stringify(fixture)+")");
      const job=await jobs.enqueue(QUEUES.indexChannel,{login,withChapters:true,limit:1});
      await check(async()=>{const [j]=await db.sql`select state,output from jobs.job where id=${job.id}`;if(j.state==='failed')throw Error(JSON.stringify(j.output));return j.state==='completed';},120000);
      assert.equal((await db.sql`select title from vods where id='v90000001'`)[0].title,'Catalog container result');
      const [owner]=await db.sql`select w.resources from worker_instances w join worker_jobs j on j.worker_id=w.id where j.job_id=${job.id}`;
      console.log('PASS: real catalog container, 256 MiB, no speech models, complete platform assignment',owner.resources.allocation);
    }else{
    for(let i=0;i<2;i++){
      const connection=await gateway.connect({label:'Container '+i}),args=connection.command.match(/(?:[^\s"]+|"[^"]*")+/g).map(x=>x.replace(/^"|"$/g,''));
      const name=args[args.indexOf('--name')+1],mount=args[args.indexOf('--mount')+1],volume=mount.match(/source=([^,]+)/)[1];containers.push(name);volumes.push(volume);
      // Generate an audio cache fixture only. Everything else is installed by the exact command from the platform.
      await docker('run','--rm','--mount',mount,'node:22-bookworm-slim','node','-e',
        "const fs=require('fs');for(let i=1;i<=6;i++){const p='/storage/data/games/unknown/fixture/v9000000'+i;fs.mkdirSync(p,{recursive:true});const n=16000*2*30,b=Buffer.alloc(44+n);b.write('RIFF',0);b.writeUInt32LE(36+n,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n,40);fs.writeFileSync(p+'/audio.m4a',b);}");
      args.splice(2,0,'--add-host=host.docker.internal:host-gateway');await docker(...args.slice(1));
    }
    // Both containers must enroll and finish bootstrap before tasks are offered.
    let lastProgress=0;
    await check(async()=>{
      if(Date.now()-lastProgress>30000){lastProgress=Date.now();console.log('Container bootstrap:',await db.sql`select label,state,resources->>'stage' as stage from worker_instances where label like 'Container %'`);
        for(const name of containers){const state=JSON.parse(await docker('inspect',name))[0];if(state.RestartCount>1)throw Error('Worker restarted during bootstrap');}}
      return Number((await db.sql`select count(*) n from worker_instances where label like 'Container %' and state='online'`)[0].n)===2;
    },15*60000);
    const submitted=[];for(const id of ids)submitted.push((await jobs.enqueue(QUEUES.analyzeVod,{vodId:id,force:true})).id);
    await check(async()=>Number((await db.sql`select count(*) n from jobs.job where id=any(${submitted}::uuid[]) and state='completed'`)[0].n)===6,120000);
    const owners=await db.sql`select distinct worker_id from worker_jobs where job_id=any(${submitted}::uuid[])`;assert.equal(owners.length,2);
    for(const name of containers){const inspect=JSON.parse(await docker('inspect',name))[0];assert(!inspect.Config.Env.some(x=>/DATABASE_URL|S3_|YOUTUBE/.test(x)));assert.equal(inspect.HostConfig.Privileged,false);assert.equal(inspect.HostConfig.Memory,6*1024**3);}
    const signals=await db.sql`select signals from vods where id=any(${ids})`;assert(signals.every(v=>v.signals.frames>0));
    console.log('PASS: two real one-command containers, CPU Python analysis, automatic registration, no DB/S3/YouTube credentials');
    // A real video traverses the platform -> container -> chunked result -> catalog path.
    // Synthetic footage only: this test must never download a stream or publish to YouTube.
    await docker('exec',containers[0],'ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=size=270x480:rate=10','-f','lavfi','-i','sine=frequency=440','-t','4','-c:v','libx264','-threads','1','-preset','ultrafast','-c:a','aac','/tmp/fixture.mp4');
    await mkdir(join(folder,'source'),{recursive:true});await docker('cp',containers[0]+':/tmp/fixture.mp4',join(folder,'source','source.mp4'));
    const sourceId=ids[4]+'_original';await db.insert(runs).values({id:'source',vodId:ids[4],streamer:login,outDir:join(folder,'source')});
    await db.insert(clips).values({id:sourceId,runId:'source',vodId:ids[4],streamer:login,segmentKey:'fixture-source',file:'source.mp4',text:'',start:0,end:4,duration:4,sizeBytes:(await stat(join(folder,'source','source.mp4'))).size});
    const cleaned=await jobs.enqueue(QUEUES.cleanClip,{clipId:sourceId,vodId:ids[4],regions:[{x:0,y:0,w:20,h:20}]});
    await check(async()=>{const [j]=await db.sql`select state,output from jobs.job where id=${cleaned.id}`;if(j.state==='failed')throw Error(JSON.stringify(j.output));return j.state==='completed';},180000);
    const [result]=await db.sql`select c.id,c.media_storage,c.size_bytes from clips c where c.id<>${sourceId} and c.vod_id=${ids[4]}`;
    assert(result&&result.sizeBytes>1000&&result.mediaStorage.videoKey&&result.mediaStorage.posterKey);
    const downloaded=await readFile(join(folder,'objects',result.mediaStorage.videoKey));assert.equal(downloaded.length,result.sizeBytes);
    console.log('PASS: real ffmpeg output and poster uploaded through the platform API and committed to the catalog');
    }
  }
}catch(error){for(const name of containers)try{console.error((await docker('logs','--tail','50',name)).replace(/[a-zA-Z0-9_-]{43,}/g,'[redacted]'));}catch{}throw error;}
finally{gateway?.onModuleDestroy();await server?.close();for(const n of containers)await docker('rm','-f',n).catch(()=>{});for(const v of volumes)await docker('volume','rm',v).catch(()=>{});
  await jobs?.onModuleDestroy();await db?.close();if(created)await admin.sql.unsafe('drop database "'+name+'" with (force)');await admin.close();}
