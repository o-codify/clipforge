// Disposable PostgreSQL; never connects to the application database or YouTube.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import PgBoss from 'pg-boss';
import {createDatabase} from '../../../packages/db/dist/client.js';
import {PlatformsService} from '../dist/platforms/platforms.service.js';
import {replenishPublicationFeeds,feedWindows} from '../../worker/dist/publication-feeds.js';
import {publicationFeedOptions,QUEUES} from '../../../packages/jobs/dist/index.js';
const docker=(...args)=>execFileSync('docker',args,{windowsHide:true,encoding:'utf8',timeout:120000}).trim();
const name='cf-feed-qa-'+randomUUID().slice(0,8);let db,boss;
try{
  docker('run','-d','--name',name,'--memory=256m','--cpus=.5','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=fixture','postgres:17-alpine');
  const port=JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const url=`postgres://postgres:fixture@127.0.0.1:${port}/postgres`;db=createDatabase({url,max:4});
  for(let i=0;;i++){try{await db.sql`select 1`;break;}catch(e){if(i>40)throw e;await new Promise(r=>setTimeout(r,250));}}
  await db.sql.unsafe(`create table platform_runtime(key text primary key,value jsonb,updated_at timestamptz default now());
    create table platform_accounts(id text,platform text,external_id text,label text,credentials jsonb,disconnect_requested_at timestamptz);
    create table streamers(login text,display_name text,avatar text);create table games(slug text,title text);
    create table vods(id text,streamer text,published_at timestamptz,duration int,chapters jsonb);
    create table runs(id text,settings jsonb,finished_at timestamptz);
    create table clips(id text,run_id text,archived_at timestamptz,state text,archive_reason text,media_released_at timestamptz);
    create table publications(id text,clip_id text,platform text,account text,media_id text,status text);
    create table remote_worker_leases(job_id uuid,state text);`);
  boss=new PgBoss({connectionString:url,schema:'jobs'});boss.on('error',()=>{});await boss.start();
  const channel='UCYW75tl-WiiRuG0YZQIdOnA';
  await db.sql`insert into streamers values('recrent','Recrent',null),('other','Other',null)`;
  await db.sql`insert into games values('wardogs','WARDOGS')`;
  await db.sql`insert into platform_accounts values('a','youtube',${channel},'Fixture','{"refreshToken":"fixture"}',null)`;
  const chapters=[{title:'WARDOGS',start:0,end:5170},{title:'Dota 2',start:5170,end:11155}];
  await db.sql`insert into vods values('v100','recrent','2026-10-01',12000,${JSON.stringify(chapters)}::jsonb),('v99','other','2026-10-02',12000,${JSON.stringify(chapters)}::jsonb)`;
  const api=new PlatformsService(db,{},{}),ctx={db};
  const options=publicationFeedOptions.parse({login:'recrent',game:'wardogs',startVodId:'v100',channelId:channel});
  const feed=await api.configureFeed(options);
  await boss.createQueue(QUEUES.indexChannel);
  const catalogJob=await boss.send(QUEUES.indexChannel,{login:'recrent'});
  assert.equal((await api.configureFeed(options)).id,feed.id,'repeated setup keeps identity');
  await assert.rejects(api.configureFeed({...options,startVodId:'v99'}));
  const windows=()=>db.sql`select key,value from platform_runtime where key like 'feed-window:%' order by key`;
  const tick=()=>replenishPublicationFeeds(ctx,boss);
  // Crash after the queue commits but before the caller receives its response.
  await assert.rejects(replenishPublicationFeeds(ctx,{createQueue:boss.createQueue.bind(boss),send:async(...a)=>{await boss.send(...a);throw Error('lost send response');}}));
  await Promise.all([tick(),tick()]);
  assert.equal((await db.sql`select count(*)::int n from jobs.job where name=${QUEUES.preparePreview}`)[0].n,1);
  assert.equal((await db.sql`select priority from jobs.job where id=${catalogJob}`)[0].priority,5,'active feed source outranks the general catalog backlog');
  let [w]=await windows();assert.equal(w.value.vodId,'v100');
  const [j]=await db.sql`select data from jobs.job where id=${w.value.jobId}`;
  assert.equal(j.data.game,'wardogs');assert.equal(j.data.count,100);assert.deepEqual(j.data.sourceRange,{start:0,end:900});
  // A retained completed lease advances even after queue retention removes a job.
  await db.sql`insert into remote_worker_leases values(${w.value.jobId},'completed')`;
  await db.sql`delete from jobs.job where id=${w.value.jobId}`;await tick();
  assert.equal((await windows()).length,2);
  const second=(await windows()).find(x=>x.value.state!=='done');
  await db.sql`update jobs.job set state='completed',completed_on=now() where id=${second.value.jobId}`;
  await db.sql`insert into runs values('r',${JSON.stringify({jobId:second.value.jobId})}::jsonb,now())`;
  for(let i=0;i<20;i++)await db.sql`insert into clips(id,run_id,archived_at,state) values(${'c'+i},'r',null,'ready')`;
  await tick();assert.equal((await windows()).length,2,'buffer stops redundant preparation');
  await db.sql`insert into publications(id,clip_id,platform,account,media_id) values('p','c0','youtube',${channel},'video')`;
  await tick();assert.equal((await windows()).length,3,'publishing refills the buffer');
  await api.configureFeed({...options,enabled:false});
  assert.equal((await db.sql`select count(*)::int n from platform_runtime where key like 'batch-publication:%' and value->>'enabled'='true'`)[0].n,0);
  const count=(await windows()).length;await tick();assert.equal((await windows()).length,count);
  await api.configureFeed(options);
  await db.sql`delete from clips`;await db.sql`delete from publications`;
  for(let i=0;i<12;i++){
    for(const item of (await windows()).filter(x=>x.value.state!=='done'))await db.sql`update jobs.job set state='completed',completed_on=now() where id=${item.value.jobId}`;
    await tick();
  }
  assert.equal((await windows()).length,6,'all six windows, never a five-clip ceiling');
  assert((await windows()).every(w=>w.value.end<=5170),'never process the Dota chapter');
  let rows=await api.feeds();assert.equal(rows[0].policy.state,'waiting-streams');
  await db.sql`insert into vods values('v200','recrent','2026-10-03',1800,'[{"title":"WARDOGS","start":0,"end":1800}]')`;
  await tick();assert((await windows()).some(w=>w.value.vodId==='v200'),'new broadcasts replenish automatically');
  const newest=(await windows()).find(w=>w.value.vodId==='v200');
  await db.sql`update jobs.job set state='failed',output='{"message":"fixture interrupted"}' where id=${newest.value.jobId}`;
  await Promise.all([tick(),tick()]);
  const nextWindow=(await windows()).find(w=>w.value.vodId==='v200'&&w.value.start===900);
  assert(nextWindow,'a failed range never blocks the next one');
  assert.equal((await api.feeds())[0].policy.deferredWindows,1);
  assert.equal((await db.sql`select count(*)::int n from jobs.job where data->>'vodId'='v200'`)[0].n,2,'concurrent ticks create only one next job');
  await db.sql`update jobs.job set state='completed' where id=${nextWindow.value.jobId}`;
  await tick();assert.equal((await api.feeds())[0].policy.state,'waiting-retry');
  assert.equal((await windows()).find(w=>w.key===newest.key).value.jobId,newest.value.jobId,'respects retry delay');
  await db.sql`update platform_runtime set value=jsonb_set(value,'{retryAt}',to_jsonb('2020-01-01T00:00:00Z'::text)) where key=${newest.key}`;
  await Promise.all([tick(),tick()]);
  const retried=(await windows()).find(w=>w.key===newest.key);
  assert.notEqual(retried.value.jobId,newest.value.jobId);assert.equal(retried.value.state,'submitted');
  assert.equal(retried.value.attempt,2);
  assert.equal((await db.sql`select count(*)::int n from jobs.job where data->>'vodId'='v200'`)[0].n,3,'only one delayed retry');
  await db.sql`update jobs.job set state='failed',output='{"message":"still uncertain"}' where id=${retried.value.jobId}`;
  await tick();assert.equal((await api.feeds())[0].policy.state,'waiting-retry');
  const delayed=(await windows()).find(w=>w.key===newest.key).value;
  assert(Date.parse(delayed.retryAt)>Date.now()+5*3600000,'second failure backs off longer');
  await db.sql`update platform_runtime set value=jsonb_set(value,'{retryAt}',to_jsonb('2020-01-01T00:00:00Z'::text)) where key=${newest.key}`;
  await tick();const last=(await windows()).find(w=>w.key===newest.key).value;
  assert.equal(last.attempt,3);
  await db.sql`update jobs.job set state='failed',output='{"message":"still uncertain"}' where id=${last.jobId}`;
  await tick();await tick();assert.equal((await api.feeds())[0].policy.state,'needs-attention');
  assert.equal((await windows()).find(w=>w.key===newest.key).value.retryAt,null,'persistent errors do not waste resources in a retry loop');
  await db.sql`insert into vods values('v300','recrent','2026-10-04',900,'[{"title":"WARDOGS","start":0,"end":900}]')`;
  await tick();assert((await windows()).some(w=>w.value.vodId==='v300'),'even an exhausted failure cannot block future broadcasts');
  const future=(await windows()).find(w=>w.value.vodId==='v300');
  await db.sql`update jobs.job set state='completed' where id=${future.value.jobId}`;
  // A retained pre-fix failure also recovers automatically after deployment.
  await db.sql`update platform_runtime set value=value-'attempt'-'retryAt' where key=${newest.key}`;
  await tick();assert.equal((await windows()).find(w=>w.key===newest.key).value.attempt,2);
  const legacyRetry=(await windows()).find(w=>w.key===newest.key).value;
  await db.sql`update jobs.job set state='failed' where id=${legacyRetry.jobId}`;await tick();
  await api.configureFeed(options);await tick();
  const manual=(await windows()).find(w=>w.key===newest.key).value;
  assert.equal(manual.attempt,1,'explicit retry restores the attempt budget');
  assert.equal(feedWindows([{id:'v1',chapters:[{title:'Dota 2',start:0,end:1800}]}],'wardogs').length,0);
  assert.deepEqual(feedWindows([{id:'v100',chapters},{id:'v200',chapters}], 'wardogs', {startVodId:'v100',startOffsetSeconds:2100}).filter(w=>w.vodId==='v100'),[
    {vodId:'v100',start:2100,end:3000},{vodId:'v100',start:3000,end:3900},
    {vodId:'v100',start:3900,end:4800},{vodId:'v100',start:4800,end:5170},
  ]);
  assert.equal(feedWindows([{id:'v200',chapters}], 'wardogs', {startVodId:'v100',startOffsetSeconds:2100})[0].start,0,'offset only applies to the initial recording');
  await assert.rejects(api.configureFeed({...options,startOffsetSeconds:5200}),/внутри выбранной игры/);
  const intro=(await windows()).find(w=>w.value.vodId==='v100'&&w.value.start===0);
  await db.sql`update jobs.job set state='failed' where id=${intro.value.jobId}`;
  await db.sql`update platform_runtime set value=jsonb_set(value,'{state}','"failed"') where key=${intro.key}`;
  await db.sql`update jobs.job set state='active' where id=${second.value.jobId}`;
  await db.sql`insert into clips(id,run_id,state) values('intro-draft','r','ready'),('intro-published','r','ready')`;
  await db.sql`insert into publications(id,clip_id,platform,account,media_id,status) values('keep','intro-published','youtube',${channel},'existing-video','published')`;
  await api.configureFeed({...options,startOffsetSeconds:2100});
  assert.equal((await db.sql`select state from jobs.job where id=${second.value.jobId}`)[0].state,'cancelled','stops an in-flight intro task');
  assert.equal((await db.sql`select archive_reason as reason from clips where id='intro-draft'`)[0].reason,'excluded-intro');
  assert.equal((await db.sql`select archived_at as archived from clips where id='intro-published'`)[0].archived,null,'preserves published history');
  await api.configureFeed({...options,enabled:false});await api.configureFeed(options);
  assert.equal((await api.feeds())[0].policy.startOffsetSeconds,2100,'pause/resume retains the verified start');
  const retired=(await windows()).filter(w=>w.value.vodId==='v100'&&w.value.start<2100);
  assert(retired.every(w=>w.value.state==='done'&&w.value.excluded),'intro attempts are never retried');
  for(const item of retired){const [p]=await db.sql`select value from platform_runtime where key=${'batch-publication:'+item.value.jobId}`;assert.equal(p.value.enabled,false,'resuming must not publish excluded intro clips');}
  await assert.rejects(api.configureFeed({...options,startOffsetSeconds:0}),/только вперёд/);
  console.log('PASS: real queue, restart/send recovery, duplicate prevention, exact streamer/game scope, pause, buffer refill, all source windows, future broadcasts');
}finally{await boss?.stop();await db?.close();try{docker('rm','-f','-v',name);}catch{}}
