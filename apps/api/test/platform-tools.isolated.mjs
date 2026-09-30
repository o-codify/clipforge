// Real HTTP, auth, queue and CLI; disposable local DB, mocked Google, no uploads.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Module} from '@nestjs/common';
import {APP_GUARD,NestFactory} from '@nestjs/core';
import {FastifyAdapter} from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import PgBoss from 'pg-boss';
import {createDatabase,upgradeRuntime,vodAudioSettings,accounts,platformAccounts,streamers,games,vods,runs,clips} from '../../../packages/db/dist/index.js';
import {QUEUES,preparePreviewPayload} from '../../../packages/jobs/dist/index.js';
import {Workspace} from '../../../packages/pipeline/dist/index.js';
import {collectMetrics,refreshYoutube} from '../../worker/dist/metrics.js';
import {servesQueue} from '../../worker/dist/routing.js';
import {renderRun,fetchVod} from '../../worker/dist/handlers.js';
import {AuthController} from '../dist/auth/auth.controller.js';
import {AuthService} from '../dist/auth/auth.service.js';
import {AuthGuard} from '../dist/auth/auth.guard.js';
import {hashPassword} from '../dist/auth/password.js';
import {PlatformsController} from '../dist/platforms/platforms.controller.js';
import {PlatformsService} from '../dist/platforms/platforms.service.js';
import {JobsController} from '../dist/jobs/jobs.controller.js';
import {JobsService} from '../dist/jobs/jobs.service.js';
import {CatalogService} from '../dist/catalog/catalog.service.js';
import {CatalogController} from '../dist/catalog/catalog.controller.js';
import {CandidatesService} from '../dist/catalog/candidates.service.js';
import {OperationsController} from '../dist/operations.controller.js';
import {ZodExceptionFilter} from '../dist/zod.filter.js';
import {CONFIG,DATABASE} from '../dist/config.js';

const root=resolve(import.meta.dirname,'../../..');
const docker=(...args)=>execFileSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:20000}).trim();
assert.match(docker('context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}'),/^npipe:/);
const name='clipforge_tools_qa_'+randomUUID().replaceAll('-','');
assert.match(name,/^clipforge_tools_qa_[a-f0-9]{32}$/);
const username=docker('exec','clipforge-postgres','printenv','POSTGRES_USER');
const url=new URL('postgres://127.0.0.1:55432/'+name);url.username=username;url.password=docker('exec','clipforge-postgres','printenv','POSTGRES_PASSWORD');
const psql=query=>docker('exec','clipforge-postgres','psql','-U',username,'-d','postgres','-v','ON_ERROR_STOP=1','-c',query);
const originalFetch=globalThis.fetch,run=promisify(execFile);
let db,app,boss,temp,created=false,googleRequests=0,round='public',videoRequests=[];
try {
  psql('CREATE DATABASE "'+name+'"');created=true;
  execFileSync(process.execPath,['packages/db/dist/migrate.js'],{cwd:root,env:{...process.env,DATABASE_URL:url.href},windowsHide:true,timeout:20000,stdio:['ignore','pipe','pipe']});
  db=createDatabase({url:url.href,max:4});await upgradeRuntime(db);
  const password='fixture-only-'+randomUUID();
  await db.insert(accounts).values([{id:'qa_admin',login:'qa_admin',role:'admin',passwordHash:await hashPassword(password)},
    {id:'qa_user',login:'qa_user',role:'user',passwordHash:await hashPassword(password)}]);
  await db.insert(streamers).values({login:'qa_sany',displayName:'QA Sany'});
  await db.insert(games).values({slug:'qa_dota',title:'Dota 2'});
  await db.insert(vods).values({id:'qa_vod',streamer:'qa_sany',game:'qa_dota'});
  await db.insert(runs).values({id:'qa_run',vodId:'qa_vod',streamer:'qa_sany',outDir:'unused',settings:{renderedClips:{qa_clip:{protection:{reviewedAt:new Date().toISOString()}}}}});
  await db.insert(clips).values({id:'qa_clip',runId:'qa_run',vodId:'qa_vod',streamer:'qa_sany',game:'qa_dota',segmentKey:'qa:0-10',file:'unused.mp4',state:'ready'});
  await db.insert(platformAccounts).values({id:'qa_account',platform:'youtube',externalId:'qa_channel',label:'QA Channel',credentials:{refreshToken:'fixture-secret'}});
  const config={databaseUrl:url.href,youtube:{clientId:'fixture',clientSecret:'fixture'},webOrigin:'http://localhost:3000'};
  class TestModule {}
  Module({controllers:[AuthController,PlatformsController,JobsController,CatalogController,OperationsController],providers:[
    {provide:DATABASE,useValue:db},{provide:CONFIG,useValue:config},{provide:AuthService,useValue:new AuthService(db)},
    PlatformsService,JobsService,CatalogService,CandidatesService,{provide:APP_GUARD,useClass:AuthGuard},
  ]})(TestModule);
  app=await NestFactory.create(TestModule,new FastifyAdapter(),{logger:['error']});
  await app.register(cookie);app.useGlobalFilters(new ZodExceptionFilter());await app.listen(0,'127.0.0.1');
  const origin=await app.getUrl();
  globalThis.fetch=async(input,init)=>{
    const address=new URL(String(input));
    if(address.origin===origin)return originalFetch(input,init);
    googleRequests++;
    if(address.href==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture-access'});
    if(address.pathname==='/youtube/v3/channels'&&address.hostname==='www.googleapis.com')return Response.json({items:[{id:'qa_channel',snippet:{title:'QA Channel'}}]});
    if(address.pathname==='/youtube/v3/videos'&&address.hostname==='www.googleapis.com'&&(init?.method??'GET')==='GET') {
      videoRequests.push(address.searchParams.get('id'));
      if(round==='error')return Response.json({error:{message:'fixture failure'}},{status:503});
      return Response.json({items:[{id:'qa_video',status:{uploadStatus:'processed',privacyStatus:round},statistics:{viewCount:'0'},contentDetails:{regionRestriction:{blocked:['BY','RU']}}}]});
    }
    assert.fail('Unexpected external request (uploads are forbidden): '+address.origin+address.pathname);
  };
  temp=await mkdtemp(join(tmpdir(),'clipforge-tools-qa-'));
  const metadata=join(temp,'metadata.json');
  await writeFile(metadata,JSON.stringify({accountId:'qa_account',title:'QA Sany | Dota 2 #Dota2',description:'#Dota2 #qa_sany',privacy:'public'}));
  const cli=async(...args)=>{
    const result=await run(process.execPath,['apps/cli/dist/main.js',...args],{cwd:root,windowsHide:true,timeout:20000,
      env:{...process.env,DATABASE_URL:'must-not-use',CLIPFORGE_URL:origin,CLIPFORGE_SESSION:'',CLIPFORGE_LOGIN:'qa_admin',CLIPFORGE_PASSWORD:password}});
    assert.equal(result.stderr,'');assert.ok(!result.stdout.includes(password));assert.ok(!result.stdout.includes('fixture-secret'));
    return JSON.parse(result.stdout);
  };
  const connected=await cli('accounts');assert.equal(connected[0].id,'qa_account');assert.equal(connected[0].credentials,undefined);
  const clipList=await cli('clips','--streamer','qa_sany');assert.equal(clipList.length,1);
  await upgradeRuntime(db); // Additive upgrade must be safe on repeated startup.
  assert.equal((await cli('vod','qa_vod')).audio.mode,'original');
  await cli('streamer-audio','qa_sany','--audio','dtln');
  assert.equal((await cli('streamer','qa_sany')).audioMode,'dtln');
  assert.equal((await cli('vod','qa_vod')).audio.mode,'dtln');
  await db.insert(vods).values({id:'qa_future_vod',streamer:'qa_sany',game:'qa_dota'});
  assert.equal((await vodAudioSettings(db,'qa_future_vod')).mode,'dtln');
  await cli('vod-audio','qa_vod','--audio','original');
  assert.equal((await cli('vod','qa_vod')).audio.mode,'original');
  await cli('vod-audio','qa_vod','--audio','inherit');
  assert.equal((await cli('vod','qa_vod')).audio.source,'streamer');
  assert.equal((await cli('vod','qa_vod')).audio.mode,'dtln');
  await cli('vod-audio','qa_vod','--audio','dtln');
  await cli('streamer-audio','qa_sany','--audio','original');
  assert.equal((await cli('vod','qa_vod')).audio.mode,'dtln');
  assert.equal((await vodAudioSettings(db,'qa_future_vod')).mode,'original');
  assert.equal((await vodAudioSettings(db,'qa_vod','original')).source,'run');
  assert.equal((await vodAudioSettings(db,'qa_vod','original')).mode,'original');
  await assert.rejects(cli('vod-audio','missing','--audio','dtln'));
  await assert.rejects(cli('streamer-audio','missing','--audio','dtln'));
  await assert.rejects(cli('vod-audio','qa_vod','--audio','invalid'));
  await assert.rejects(cli('render','qa_vod','--test-batch','--count','21'));
  const batch=await cli('render','qa_vod','--test-batch','--count','10');
  const [batchJob]=await db.sql`select name,data from jobs.job where id=${batch.id}::uuid`;
  assert.equal(batchJob.name,QUEUES.renderVariant);
  assert.deepEqual(batchJob.data,{vodId:'qa_vod',count:10,skipExisting:true,testBatch:true});
  const prepared=await cli('prepare','qa_vod','--count','6','--audio','dtln');
  const [preparedJob]=await db.sql`select name,data from jobs.job where id=${prepared.id}::uuid`;
  assert.equal(preparedJob.name,QUEUES.preparePreview);
  assert.deepEqual(preparedJob.data,{vodId:'qa_vod',count:6,audioMode:'dtln',reuse:true,skipExisting:true,testBatch:true});
  assert.equal((await cli('prepare','qa_vod','--count','6','--audio','dtln')).id,prepared.id);
  assert.equal((await db.sql`select count(*)::int as n from publications`)[0].n,0,'Prepare must not publish');
  assert.equal((await vodAudioSettings(db,'qa_future_vod')).mode,'original','Per-batch audio must not change streamer settings');
  assert.equal(servesQueue('media',QUEUES.preparePreview),true);
  assert.equal(servesQueue('control',QUEUES.preparePreview),false);
  for(const override of [{testBatch:false},{skipExisting:false},{count:21}])
    assert.throws(()=>preparePreviewPayload.parse({...preparedJob.data,...override}));
  // Saved source remains usable when Twitch has already removed the VOD.
  const source=await new Workspace({data:join(temp,'data'),out:join(temp,'out')},{game:'qa_dota',streamer:'qa_sany',vodId:'qa_vod'}).prepare();
  await writeFile(source.audio,'fixture');await writeFile(source.video('720p60'),'fixture');
  const cached=await fetchVod({db,config:{data:join(temp,'data'),out:join(temp,'out'),role:'media',videoFormat:'720p60',workerRoot:'missing',pythonBin:'must-not-run'}},
    {vodId:'qa_vod',audioOnly:false},{log:()=>{},cancelled:async()=>false});
  assert.deepEqual(cached,{audio:source.audio,video:source.video('720p60')});
  assert.equal((await db.sql`select state from clips where id='qa_clip'`)[0].state,'ready','Settings must not edit existing clips');
  // Crash after the final clip commit: the same job must finish its existing run,
  // even if the caller's count/defaults changed; it must never invoke media tools.
  await db.sql`update runs set settings=settings || ${JSON.stringify({jobId:'qa_retry',testBatch:true,requestedCount:1,audioSettings:{mode:'dtln',override:'dtln',streamerMode:'original',source:'vod'}})}::jsonb where id='qa_run'`;
  const recoveredBatch=await renderRun({db,config:{data:join(temp,'data'),out:join(temp,'out'),clipsPerRun:24},
    python:{call:()=>assert.fail('Completed batch must not render again')}},
    {vodId:'qa_vod',count:10,testBatch:true},{id:'qa_retry',log:()=>{},cancelled:async()=>false});
  assert.deepEqual(recoveredBatch,{runId:'qa_run',rendered:1,skipped:0,replaced:0});
  assert.ok((await db.sql`select finished_at from runs where id='qa_run'`)[0].finishedAt);
  const render=await cli('render','qa_vod','--fresh','--audio','dtln');
  assert.ok(render.id);
  const [renderJob]=await db.sql`select name,data from jobs.job where id=${render.id}::uuid`;
  assert.equal(renderJob.name,QUEUES.renderVariant,'Legacy workers must not silently ignore DTLN/fresh options');
  assert.deepEqual(renderJob.data,{vodId:'qa_vod',count:1,skipExisting:true,audioMode:'dtln'});
  assert.equal(servesQueue('media',QUEUES.renderVariant),true);
  assert.equal(servesQueue('control',QUEUES.renderVariant),false);
  const preview=await cli('preview','qa_clip');assert.ok(preview.title.includes('Dota'));assert.ok(preview.description.includes('#'));
  const [first,second]=await Promise.all([cli('publish','qa_clip','--metadata',metadata),cli('publish','qa_clip','--metadata',metadata)]);
  assert.equal(first.publicationId,second.publicationId);assert.equal(first.jobId,second.jobId);assert.ok(first.jobId);
  assert.equal((await db.sql`select count(*)::int as n from publications`)[0].n,1);
  assert.equal((await db.sql`select count(*)::int as n from jobs.job where name=${QUEUES.publishClip}`)[0].n,1);
  const before=googleRequests;
  let publication=await cli('publication',first.publicationId);
  assert.equal(googleRequests,before,'Read publication never contacts Google');
  assert.equal(publication.actualPrivacy,null);assert.equal(publication.storedPrivacy,'public');assert.equal(publication.stale,true);
  assert.equal(publication.copyrightClaim,'unknown');
  // Recover a process crash between publication creation and queue submission.
  await db.sql`delete from jobs.job where id=${first.jobId}::uuid`;
  const recovered=await cli('publish','qa_clip','--metadata',metadata);
  assert.equal(recovered.publicationId,first.publicationId);assert.ok(recovered.jobId);assert.notEqual(recovered.jobId,first.jobId);
  assert.equal((await db.sql`select count(*)::int as n from publications`)[0].n,1);
  // Simulate worker's completed upload, not a real remote upload.
  await db.sql`update publications set media_id='qa_video',status='processing' where id=${first.publicationId}`;
  const [refresh1,refresh2]=await Promise.all([cli('refresh',first.publicationId),cli('refresh',first.publicationId)]);
  assert.equal(refresh1.jobId,refresh2.jobId);assert.ok(refresh1.jobId);
  assert.equal((await db.sql`select count(*)::int as n from jobs.job where name=${QUEUES.refreshYoutube}`)[0].n,1);
  boss=new PgBoss({connectionString:url.href,schema:'jobs'});boss.on('error',()=>{});await boss.start();
  const [work]=await boss.fetch(QUEUES.refreshYoutube);assert.equal(work.id,refresh1.jobId);
  const ctx={db,youtube:config.youtube};const report={log:()=>{},cancelled:async()=>false};
  await boss.complete(QUEUES.refreshYoutube,work.id,await refreshYoutube(ctx,work.data,report));
  assert.equal((await cli('wait',work.id,'--timeout','1')).state,'completed');
  publication=await cli('publication',first.publicationId);
  assert.equal(publication.actualPrivacy,'public');assert.equal(publication.status,'published');assert.equal(publication.stale,false);
  assert.deepEqual(publication.restrictions.regionRestriction.blocked,['BY','RU']);assert.equal(publication.views,0);assert.equal(publication.likes,null);
  assert.deepEqual(videoRequests,['qa_video']);
  const previousJobCount=(await db.sql`select count(*)::int as n from jobs.job where name=${QUEUES.publishClip}`)[0].n;
  assert.equal((await cli('publish','qa_clip','--metadata',metadata)).existing,true);
  assert.equal((await db.sql`select count(*)::int as n from jobs.job where name=${QUEUES.publishClip}`)[0].n,previousJobCount);
  round='private';await refreshYoutube(ctx,{publicationId:first.publicationId},report);
  assert.equal((await cli('publication',first.publicationId)).actualPrivacy,'private');
  await db.sql`update publications set status='failed' where id=${first.publicationId}`;
  assert.equal((await cli('publish','qa_clip','--metadata',metadata)).existing,true);
  assert.equal((await db.sql`select status from publications where id=${first.publicationId}`)[0].status,'failed','An existing remote video must be checked, not queued for upload again');
  round='error';await assert.rejects(refreshYoutube(ctx,{publicationId:first.publicationId},report),/Не удалось обновить/);
  round='public';
  const lock=await db.sql.reserve();
  try {
    await lock`select pg_advisory_lock(740024)`;
    const calls=googleRequests;assert.equal((await collectMetrics(ctx)).state,'busy');assert.equal(googleRequests,calls);
  } finally {await lock`select pg_advisory_unlock(740024)`;lock.release();}
  assert.equal(servesQueue('control',QUEUES.refreshYoutube),true);assert.equal(servesQueue('media',QUEUES.refreshYoutube),false);
  // Normal HTTP authorization, including preview mode; no forged controller context.
  for(const role of ['anonymous','user','preview']) {
    let session;
    if(role!=='anonymous') {
      const login=await originalFetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:role==='user'?'qa_user':'qa_admin',password})});
      session=login.headers.getSetCookie()[0].split(';')[0];
      if(role==='preview') await originalFetch(origin+'/api/auth/act-as',{method:'POST',headers:{Cookie:session,'Content-Type':'application/json'},body:JSON.stringify({streamer:'qa_sany'})});
    }
    for(const [path,method,body] of [[`/api/platforms/publications/${first.publicationId}`,'GET'],['/api/platforms/youtube/refresh','POST',{}],['/api/platforms/publish/qa_clip','POST',{}],
      ['/api/vods/qa_vod/audio','POST',{audioMode:'dtln'}],['/api/streamers/qa_sany/audio','POST',{audioMode:'dtln'}],
      ['/api/jobs/render/qa_vod','POST',{count:10,testBatch:true}],['/api/jobs/prepare/qa_vod','POST',{count:6,audioMode:'dtln'}]]) {
      const response=await originalFetch(origin+path,{method,headers:{...(session?{Cookie:session}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      assert.equal(response.status,role==='anonymous'?401:403,role+' '+path);
    }
    if(session)await originalFetch(origin+'/api/auth/logout',{method:'POST',headers:{Cookie:session,'Content-Type':'application/json'},body:'{}'});
  }
  assert.equal((await db.sql`select count(*)::int as n from sessions`)[0].n,0,'CLI closes its sessions');
  await db.sql`update platform_accounts set disconnect_requested_at=now() where id='qa_account'`;
  await assert.rejects(cli('refresh',first.publicationId));
  console.log('PASS: CLI → authenticated HTTP → durable queue; duplicate publish/refresh coalesced; job result; public/private facts; regions; null counts; collector exclusion; failed refresh; permissions; session cleanup. No real uploads.');
} finally {
  globalThis.fetch=originalFetch;
  await boss?.stop();await app?.close();await db?.close();
  if(temp) {assert.ok(temp.startsWith(join(tmpdir(),'clipforge-tools-qa-')));await rm(temp,{recursive:true,force:true});}
  if(created){assert.match(name,/^clipforge_tools_qa_[a-f0-9]{32}$/);psql('DROP DATABASE "'+name+'" WITH (FORCE)');}
}
