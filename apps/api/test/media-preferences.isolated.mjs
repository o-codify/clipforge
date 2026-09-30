// Disposable LOCAL DB only. Never load the workspace DATABASE_URL.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createDatabase,upgradeRuntime,streamers,vods,runs,clips,vodAdSettings,vodAudioSettings} from '../../../packages/db/dist/index.js';
import {CatalogService} from '../dist/catalog/catalog.service.js';
import {CatalogController} from '../dist/catalog/catalog.controller.js';
import {JobsController} from '../dist/jobs/jobs.controller.js';
import {JobsService} from '../dist/jobs/jobs.service.js';
import {PlatformsService} from '../dist/platforms/platforms.service.js';
import {prepareStreamer} from '../../worker/dist/prepare-streamer.js';
const docker=(...args)=>execFileSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:20000}).trim();
assert.match(docker('context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}'),/^npipe:/);
const name='clipforge_prefs_qa_'+randomUUID().replaceAll('-','');
const user=docker('exec','clipforge-postgres','printenv','POSTGRES_USER');
const url=new URL('postgres://127.0.0.1:55432/'+name);
url.username=user;url.password=docker('exec','clipforge-postgres','printenv','POSTGRES_PASSWORD');
const psql=query=>docker('exec','clipforge-postgres','psql','-U',user,'-d','postgres','-v','ON_ERROR_STOP=1','-c',query);
let db,jobs,created=false;
try {
  for(const [controller,method] of [[CatalogController,'streamerAds'],[CatalogController,'vodAds'],[JobsController,'prepareStreamer']])
    assert.equal(Reflect.getMetadata('adminOnly',controller.prototype[method]),true);
  psql(`CREATE DATABASE "${name}"`);created=true;
  for(let n=0;n<2;n++)execFileSync(process.execPath,['packages/db/dist/migrate.js'],{env:{...process.env,DATABASE_URL:url.href},windowsHide:true,timeout:20000,stdio:'pipe'});
  db=createDatabase({url:url.href,max:3});await upgradeRuntime(db);
  await db.insert(streamers).values([{login:'sany'},{login:'other'}]);
  await db.insert(vods).values([1,2,3].map(n=>({id:'v'+n,streamer:'sany',duration:7200})));
  await db.insert(vods).values({id:'other-vod',streamer:'other'});
  const catalog=new CatalogService(db),viewer={isAdmin:true,actingAs:null,role:'admin'};
  jobs=new JobsService({databaseUrl:url.href},db);
  const jobsController=new JobsController(jobs,catalog);
  const queued=await jobsController.prepareStreamer(viewer,'sany',{count:100,audioMode:'dtln-gated',vodIds:['v1','v2','v3']});
  assert.ok(queued.id);
  assert.equal((await jobsController.prepareStreamer(viewer,'sany',{count:100,audioMode:'dtln-gated',vodIds:['v1','v2','v3']})).id,queued.id);
  await assert.rejects(jobsController.prepareStreamer(viewer,'sany',{count:100,vodIds:['v1','other-vod']}),/стримеру/);
  assert.equal((await vodAdSettings(db,'v1')).enabled,true);
  await catalog.setVodAds('v1',true);
  await catalog.setStreamerAds('sany',false,false);
  assert.equal((await vodAdSettings(db,'v1')).enabled,true);
  assert.equal((await vodAdSettings(db,'v2')).enabled,false);
  await catalog.setStreamerAds('sany',false,true);
  await db.insert(vods).values({id:'future',streamer:'sany'});
  for(const id of ['v1','v2','v3','future'])assert.deepEqual(await vodAdSettings(db,id),{override:null,streamerEnabled:false,enabled:false,source:'streamer'});
  assert.equal((await vodAdSettings(db,'other-vod')).enabled,true);
  await catalog.setVodAudio('v1','dtln-gated');
  assert.equal((await vodAudioSettings(db,'v1')).mode,'dtln-gated');
  assert.equal((await vodAudioSettings(db,'v2')).mode,'original');
  // A partial VOD survives an infrastructure failure and does not count twice.
  const report={id:randomUUID(),cancelled:async()=>false,log:()=>{}};
  let injected=false;const counts=[];
  const pipeline=async(_ctx,input)=>{
    assert.equal(input.testBatch,true);assert.equal(input.skipExisting,true);assert.equal(input.audioMode,'dtln-gated');
    counts.push(input.count);
    const id='run-'+input.vodId;
    await db.insert(runs).values({id,vodId:input.vodId,streamer:'sany',outDir:'fixture',settings:{jobId:report.id}}).onConflictDoNothing();
    const [row]=await db.sql`select count(*)::int as count from clips where run_id=${id}`;
    const end=!injected?18:input.count;
    for(let n=row.count;n<end;n++)await db.insert(clips).values({id:id+'-'+n,runId:id,vodId:input.vodId,streamer:'sany',file:'fixture.mp4',segmentKey:input.vodId+':'+n,state:'draft',start:n*60,end:n*60+30,duration:30,version:'fixture'});
    if(!injected){injected=true;throw new Error('Temporary worker failure');}
    return {runId:id,rendered:input.count,skipped:0,replaced:0};
  };
  const input={login:'sany',count:100,audioMode:'dtln-gated',vodIds:['v1','v2','v3']};
  await assert.rejects(prepareStreamer({db},input,report,pipeline),/Temporary/);
  const result=await prepareStreamer({db},input,report,pipeline);
  assert.equal(result.rendered,100);assert.equal(result.publication,'hold-for-user-review');
  assert.deepEqual(counts,[40,40,40,20]);
  assert.equal((await prepareStreamer({db},input,report,pipeline)).rendered,100);
  assert.equal(counts.length,4);
  assert.equal((await db.sql`select count(*)::int as count from clips where state='draft'`)[0].count,100);
  assert.equal((await db.sql`select count(*)::int as count from publications`)[0].count,0);
  // Disabled policy is not a fictitious successful scan, and draft still blocks upload.
  const platforms=new PlatformsService(db,{},{}),clipId='run-v1-0';
  await assert.rejects(catalog.setClipState(viewer,clipId,'ready'),/обработку рекламы/);
  await db.sql`update runs set settings=settings || ${JSON.stringify({renderedClips:{[clipId]:{protection:{disabledAt:new Date().toISOString(),ads:{enabled:false,regions:[]},audio:{method:'dtln'}}}}})}::jsonb where id='run-v1'`;
  await assert.rejects(platforms.preview(clipId),/недоступен/);
  await catalog.setClipState(viewer,clipId,'ready');
  const clip=await catalog.clip(viewer,clipId);
  assert.ok(clip.safety.disabledAt);assert.equal(clip.safety.autoVerifiedAt,null);assert.equal(clip.safety.reviewedAt,null);
  assert.ok((await platforms.preview(clipId)).title);
  console.log('PASS: migration, inherited preferences, isolated overrides, 100 draft resume, no upload, truthful disabled proof');
} finally {
  await jobs?.onModuleDestroy();
  await db?.close();
  if(created)psql(`DROP DATABASE "${name}" WITH (FORCE)`);
}
