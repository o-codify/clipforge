// A fresh disposable DB on a local Postgres only. Never reads DATABASE_URL.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import PgBoss from 'pg-boss';
import {setTimeout as delay} from 'node:timers/promises';
import {createDatabase,upgradeRuntime,streamers,games,vods,runs,clips,platformAccounts,publications,publicationMetrics,runtimeValue,withVodLock,beginYoutubeDisconnect} from '../../../packages/db/dist/index.js';
import {ShortsController} from '../dist/shorts.controller.js';
import {WorkersController} from '../dist/workers.controller.js';
import {PublicationProcessController} from '../dist/publication-process.controller.js';
import {WorkerRegistry,recoverWorkers} from '../../worker/dist/registry.js';
import {startConsumers} from '../../worker/dist/consumers.js';
import {reserveUpload,uploadWait} from '../../worker/dist/upload-quota.js';
import {prepareStreamer} from '../../worker/dist/prepare-streamer.js';
import {AuthGuard} from '../dist/auth/auth.guard.js';
import {Reflector} from '@nestjs/core';

const root=new URL('../../../',import.meta.url);
const adminUrl=new URL(process.env.CLIPFORGE_TEST_DB_URL||'postgres://clipforge:clipforge@127.0.0.1:55432/postgres');
assert(['127.0.0.1','localhost'].includes(adminUrl.hostname));
assert(['5432','55432'].includes(adminUrl.port),'Production tunnel is forbidden');
const name='clipforge_fleet_qa_'+randomUUID().replaceAll('-','');
const admin=createDatabase({url:adminUrl.href,max:2});
const url=new URL(adminUrl);url.pathname='/'+name;
let db,boss,created=false,stoppers=[];
const until=async(fn,timeout=15000)=>{const deadline=Date.now()+timeout;while(!await fn()){if(Date.now()>deadline)throw Error('Timed out');await delay(50);}};
try{
  await admin.sql.unsafe('create database "'+name+'"');created=true;
  execFileSync(process.execPath,['packages/db/dist/migrate.js'],{cwd:root,env:{...process.env,DATABASE_URL:url.href},windowsHide:true,stdio:'pipe'});
  db=createDatabase({url:url.href,max:10});await upgradeRuntime(db);
  boss=new PgBoss({connectionString:url.href,schema:'jobs'});boss.on('error',e=>{throw e;});await boss.start();
  for(const login of ['sany','other'])await db.insert(streamers).values({login,displayName:login.toUpperCase()});
  await db.insert(games).values({slug:'dota',title:'Dota 2'});
  await db.insert(vods).values([{id:'vod-a',streamer:'sany',game:'dota'},{id:'vod-b',streamer:'other'}]);
  await db.insert(runs).values({id:'run',vodId:'vod-a',streamer:'sany',outDir:'unused'});
  await db.insert(platformAccounts).values({id:'channel',platform:'youtube',externalId:'UCqa',label:'QA channel',credentials:{refreshToken:'fixture'}});
  for(let i=0;i<45;i++){
    await db.insert(clips).values({id:'clip'+i,runId:'run',vodId:i<43?'vod-a':'vod-b',streamer:i<43?'sany':'other',game:i<43?'dota':null,segmentKey:String(i),file:'unused.mp4'});
    await db.insert(publications).values({id:'pub'+i,clipId:'clip'+i,platform:'youtube',account:'UCqa',mediaId:'video'+i,status:'published',privacy:i===44?'private':'public',title:'Clip '+i,publishedAt:new Date(Date.now()-86400000)});
    if(i<44)await db.insert(publicationMetrics).values({id:randomUUID(),publicationId:'pub'+i,views:i,likes:0,comments:null,collectedAt:new Date(Date.now()-3600000),extended:{privacy:'public'}});
  }
  const shorts=new ShortsController(db),workers=new WorkersController(db);
  const first=await shorts.list({}),second=await shorts.list({page:2});
  assert.equal(first.total,45);assert.equal(first.rows.length,40);assert.equal(second.rows.length,5);
  assert.equal(new Set([...first.rows,...second.rows].map(x=>x.id)).size,45);
  const sany=await shorts.analytics({streamer:'sany'});
  assert.equal(sany.summary.videos,43);assert.equal(sany.summary.views,'903');assert.equal(sany.summary.likes,'0');assert.equal(sany.summary.comments,null);
  assert.equal(sany.aggregate.at(-1).views,903);assert.equal(sany.series.length,8);
  assert.equal(sany.feedbackAllowed,false);assert.equal((await shorts.list({game:'dota'})).total,43);
  assert.equal((await shorts.list({privacy:'private'})).total,1);
  assert.equal((await shorts.filters()).streamers.length,2);
  await assert.rejects(shorts.list({page:0}));
  assert.equal((await new PublicationProcessController(db).status()).channels.length,1);

  for(const Controller of [ShortsController,WorkersController,PublicationProcessController]){
    const context={getHandler:()=>Controller.prototype.list??Controller.prototype.status,getClass:()=>Controller,switchToHttp:()=>({getRequest:()=>({method:'GET',url:'/api',cookies:{}})})};
    for(const viewer of [null,{isAdmin:false,role:'user'},{isAdmin:false,role:'admin',isPreview:true}])await assert.rejects(new AuthGuard({viewerFor:async()=>viewer},new Reflector()).canActivate(context));
  }
  // Two independent pullers share real pg-boss queues. At most one heavy job per worker.
  const queues=['heavy.qa-a','heavy.qa-b'];for(const q of queues)await boss.createQueue(q);
  for(let i=0;i<8;i++)await boss.send(queues[i%2],{i});
  const active=[0,0],finished=[],owners=new Set();let maxTotal=0;
  const registries=[new WorkerRegistry(db),new WorkerRegistry(db)];
  Object.defineProperty(registries[0],'id',{value:'qa-worker-a'});Object.defineProperty(registries[1],'id',{value:'qa-worker-b'});
  for(let i=0;i<2;i++){
    const registry=registries[i];await registry.register('media',queues);await registry.beat({allocation:{cpus:2,memoryMb:2048,usedMb:100}});
    stoppers.push(startConsumers(boss,queues,async(q,job)=>{
      await registry.claim(job.id);await registry.stage(job.id,'Проверка');
      active[i]++;assert.equal(active[i],1);maxTotal=Math.max(maxTotal,active[0]+active[1]);owners.add(i);
      await delay(200);active[i]--;finished.push(job.id);await registry.finish(job.id);
      return {ok:true};
    },async()=>!registry.draining,()=>{}));
  }
  await until(()=>finished.length===8);await Promise.all(stoppers.map(stop=>stop()));stoppers=[];
  assert.equal(new Set(finished).size,8);assert.equal(maxTotal,2);assert.equal(owners.size,2);
  assert.equal((await workers.list()).length,2);
  const autoId=randomUUID();await db.sql`insert into automation_runs(id,name,state) values(${autoId},'platform.metrics','active')`;
  await registries[1].claim(autoId);
  assert((await workers.list()).find(w=>w.id==='qa-worker-b').active.some(j=>j.name==='platform.metrics'));
  assert((await workers.jobs({worker:'qa-worker-b'})).rows.some(j=>j.name==='platform.metrics'),'Include scheduled controller tasks');
  await db.sql`update automation_runs set state='completed',completed_at=now() where id=${autoId}`;await registries[1].finish(autoId);
  assert((await workers.jobs({worker:'qa-worker-a'})).rows.every(j=>j.workerId==='qa-worker-a'));
  await workers.drain('qa-worker-a',{draining:true});await registries[0].beat({});assert(registries[0].draining);

  let inside=0,maxInside=0;
  await Promise.all([1,2].map(()=>withVodLock(db,'same-vod',async()=>{inside++;maxInside=Math.max(maxInside,inside);await delay(80);inside--;})));
  assert.equal(maxInside,1,'Two workers cannot work on the same VOD concurrently');

  // A coordinator must not occupy its worker's only heavy slot while waiting for children.
  process.env.WORKER_FLEET='true';
  await db.insert(vods).values({id:'vod-c',streamer:'sany',game:'dota'});
  for(const q of ['heavy.prepare-streamer','heavy.prepare-batch-vod'])await boss.createQueue(q);
  const parent=await boss.send('heavy.prepare-streamer',{login:'sany',vodIds:['vod-a','vod-c'],count:6});
  const stopParent=startConsumers(boss,['heavy.prepare-streamer','heavy.prepare-batch-vod'],async(q,job)=>{
    if(q==='heavy.prepare-streamer')return prepareStreamer({db,queue:boss,config:{role:'control'}},job.data,{id:job.id,log:()=>{},cancelled:async()=>false});
    const runId='child-'+job.data.vodId;
    await db.insert(runs).values({id:runId,vodId:job.data.vodId,streamer:'sany',outDir:'unused',settings:{jobId:job.data.batchId}});
    for(let i=0;i<job.data.count;i++)await db.insert(clips).values({id:runId+'-'+i,runId,vodId:job.data.vodId,streamer:'sany',file:'unused',segmentKey:runId+'-'+i});
    return {rendered:job.data.count};
  },async()=>true,()=>{});stoppers.push(stopParent);
  await until(async()=>['completed','failed'].includes((await boss.getJobById('heavy.prepare-streamer',parent)).state),20000);
  assert.equal((await boss.getJobById('heavy.prepare-streamer',parent)).state,'completed');
  const plan=(await db.sql`select value from platform_runtime where key=${'draft-batch:'+parent}`)[0].value;
  assert.equal(plan.ready,6);assert.equal(Object.keys(plan.children).length,2);
  await stopParent();stoppers=[];delete process.env.WORKER_FLEET;

  const staleQueue='heavy.qa-stale';await boss.createQueue(staleQueue);
  await boss.send(staleQueue,{}, {retryLimit:1,retryDelay:1});const [lost]=await boss.fetch(staleQueue);
  await registries[0].claim(lost.id);
  await db.sql`update worker_instances set heartbeat_at=now()-interval '2 minutes' where id='qa-worker-a'`;
  const lease=await db.sql.reserve();await lease`select pg_advisory_lock(hashtextextended('worker:qa-worker-a',0))`;
  await recoverWorkers(db,boss);assert.equal((await boss.getJobById(staleQueue,lost.id)).state,'active');
  await lease`select pg_advisory_unlock(hashtextextended('worker:qa-worker-a',0))`;lease.release();
  await recoverWorkers(db,boss);assert.equal((await boss.getJobById(staleQueue,lost.id)).state,'retry');

  await runtimeValue(db,'youtube-quota',{state:'ok',remaining:1,start:new Date(Date.now()-3600000).toISOString(),resetAt:new Date(Date.now()+3600000).toISOString()});
  const admits=await Promise.allSettled([reserveUpload(db,'UCqa','p1'),reserveUpload(db,'UCqa','p2')]);
  assert.equal(admits.filter(x=>x.status==='fulfilled').length,1);assert.match(admits.find(x=>x.status==='rejected').reason.message,/quota-wait/);
  assert(await uploadWait(db,'another-channel'),'Quota is shared by all channels in the project');
  const publicationState=await new PublicationProcessController(db).status();
  assert.equal(publicationState.available,0);assert.equal(publicationState.reserved,1);
  assert.equal(publicationState.channels[0].attemptsToday,1,'Count API initiations, not queued publication records');
  await runtimeValue(db,'feedback:sany',{samples:6});
  await beginYoutubeDisconnect(db,'channel');assert.equal((await shorts.list({})).total,0);assert.equal((await shorts.analytics({})).aggregate.length,0);
  assert.equal((await db.sql`select key from platform_runtime where key='feedback:sany'`).length,0);
  console.log('PASS: all-Shorts analytics/filtering/pagination, admin isolation, two workers/no duplicate claims/no hoarding, drain, VOD locking, dead-owner recovery, atomic cross-channel quota admission and data removal. No external requests.');
}finally{
  await Promise.all(stoppers.map(stop=>stop()));await boss?.stop({graceful:false});await db?.close();
  if(created){assert.match(name,/^clipforge_fleet_qa_[a-f0-9]{32}$/);await admin.sql.unsafe('drop database "'+name+'" with (force)');}
  await admin.close();
}
