// Uses only a NEW local disposable database. Google calls are mocked.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createDatabase,upgradeRuntime,streamers,games,vods,runs,clips,platformAccounts,publications,publicationMetrics,runtimeValue} from '../../../packages/db/dist/index.js';
import {collectMetrics,youtubeCount} from '../../worker/dist/metrics.js';
import {OperationsController} from '../dist/operations.controller.js';
import {AuthGuard} from '../dist/auth/auth.guard.js';
import {Reflector} from '@nestjs/core';

const docker=(...args)=>execFileSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:20000}).trim();
assert.match(docker('context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}'),/^npipe:/);
const name='clipforge_analytics_qa_'+randomUUID().replaceAll('-','');
assert.match(name,/^clipforge_analytics_qa_[a-f0-9]{32}$/);
const username=docker('exec','clipforge-postgres','printenv','POSTGRES_USER');
const url=new URL('postgres://127.0.0.1:55432/'+name);url.username=username;url.password=docker('exec','clipforge-postgres','printenv','POSTGRES_PASSWORD');
const psql=query=>docker('exec','clipforge-postgres','psql','-U',username,'-d','postgres','-v','ON_ERROR_STOP=1','-c',query);
const originalFetch=globalThis.fetch;
let db,created=false,round=0,requests=0;
try {
 psql('CREATE DATABASE "'+name+'"');created=true;
 execFileSync(process.execPath,['packages/db/dist/migrate.js'],{cwd:resolve(import.meta.dirname,'../../..'),env:{...process.env,DATABASE_URL:url.href},windowsHide:true,timeout:20000,stdio:['ignore','pipe','pipe']});
 db=createDatabase({url:url.href,max:2});await upgradeRuntime(db);
 await db.insert(streamers).values({login:'qa_sany',displayName:'QA Sany'});
 await db.insert(games).values({slug:'qa_dota',title:'QA Dota'});
 await db.insert(vods).values({id:'qa_vod',streamer:'qa_sany',game:'qa_dota'});
 await db.insert(runs).values({id:'qa_run',vodId:'qa_vod',streamer:'qa_sany',outDir:'unused'});
 await db.insert(clips).values({id:'qa_clip',runId:'qa_run',vodId:'qa_vod',streamer:'qa_sany',segmentKey:'qa:0-10',file:'unused.mp4'});
 await db.insert(platformAccounts).values({id:'qa_account',platform:'youtube',externalId:'qa_channel',label:'QA Channel',credentials:{refreshToken:'fixture'}});
 await db.insert(publications).values({id:'qa_publication',clipId:'qa_clip',platform:'youtube',account:'qa_channel',mediaId:'qa_video',status:'processing',privacy:'public',title:'QA clip'});
 globalThis.fetch=async(input)=>{
  requests++;const url=new URL(String(input));
  if(url.href==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture'});
  if(url.hostname==='www.googleapis.com'&&url.pathname==='/youtube/v3/channels')return Response.json({items:[{id:'qa_channel',snippet:{title:'QA Channel'}}]});
  if(url.hostname==='www.googleapis.com'&&url.pathname==='/youtube/v3/videos'){
   assert.match(url.searchParams.get('part'),/contentDetails/);
   return Response.json({items:[{id:'qa_video',snippet:{publishedAt:'2026-09-20T10:00:00Z'},status:{uploadStatus:'processed',privacyStatus:round?'private':'public'},statistics:round?undefined:{viewCount:'12',likeCount:'0'},contentDetails:{regionRestriction:{blocked:['BY','RU']},contentRating:{ytRating:'ytAgeRestricted'}}}]});
  }
  throw Error('Unexpected network request: '+url.origin+url.pathname);
 };
 const ctx={db,youtube:{clientId:'fixture',clientSecret:'fixture'}};
 await collectMetrics(ctx);
 let [p]=await db.sql`select privacy,status,published_at from publications where id='qa_publication'`;
 assert.equal(p.privacy,'public');assert.equal(p.status,'published');assert.equal(new Date(p.publishedAt).toISOString(),'2026-09-20T10:00:00.000Z');
 const controller=new OperationsController(db);
 await runtimeValue(db,'control',{state:'online',role:'control'});
 let result=await controller.videoAnalytics();
 assert.equal(result.collectorOnline,true);assert.equal(result.sync.state,'ok');assert.equal(result.rows.length,1);
 assert.equal(result.rows[0].views,12);assert.equal(result.rows[0].likes,0);assert.equal(result.rows[0].comments,null);
 assert.deepEqual(result.rows[0].details.regionRestriction,{blocked:['BY','RU']});assert.equal(result.rows[0].details.ageRestricted,true);
 assert.deepEqual(await controller.analytics(),[],'Raw counts do not enable derived scoring');
 round=1;await collectMetrics(ctx);
 result=await controller.videoAnalytics();assert.equal(result.rows[0].privacy,'private');assert.equal(result.rows[0].status,'uploaded');
 assert.equal(result.rows[0].views,null,'Newest absent stats must not resurrect old counts');assert.equal(result.rows[0].likes,null);
 [p]=await db.sql`select published_at from publications where id='qa_publication'`;assert.equal(p.publishedAt,null);
 // Pagination remains stable with more than one page and omits disconnected channels.
 for(let i=0;i<51;i++) {
  await db.insert(clips).values({id:'qa_clip_'+i,runId:'qa_run',vodId:'qa_vod',streamer:'qa_sany',segmentKey:'extra:'+i,file:'unused.mp4'});
  await db.insert(publications).values({id:'qa_pub_'+i,clipId:'qa_clip_'+i,platform:'youtube',account:'qa_channel',mediaId:'qa_video_'+i,status:'uploaded',privacy:'private'});
 }
 const first=await controller.videoAnalytics('1'),second=await controller.videoAnalytics('2');
 assert.equal(first.rows.length,50);assert.equal(first.hasMore,true);assert.equal(second.rows.length,2);assert.equal(second.hasMore,false);
 assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,52);
 await assert.rejects(controller.videoAnalytics('0'));await assert.rejects(controller.videoAnalytics('1001'));
 await db.sql`update platform_runtime set updated_at=now()-interval '2 minutes' where key='control'`;
 assert.equal((await controller.videoAnalytics()).collectorOnline,false);
 await runtimeValue(db,'worker',{state:'online',role:'all'});assert.equal((await controller.videoAnalytics()).collectorOnline,true);
 await db.sql`update platform_accounts set disconnect_requested_at=now() where id='qa_account'`;
 assert.equal((await controller.videoAnalytics()).rows.length,0);
 const request={method:'GET',url:'/api/operations/analytics/videos',cookies:{}};
 const context={getHandler:()=>OperationsController.prototype.videoAnalytics,getClass:()=>OperationsController,switchToHttp:()=>({getRequest:()=>request})};
 for(const viewer of [null,{isAdmin:false,role:'user'},{isAdmin:false,role:'admin',isPreview:true}]) {
  await assert.rejects(new AuthGuard({viewerFor:async()=>viewer},new Reflector()).canActivate(context));
 }
 assert.equal(await new AuthGuard({viewerFor:async()=>({isAdmin:true,role:'admin'})},new Reflector()).canActivate(context),true);
 assert.equal(youtubeCount(undefined),null);assert.equal(youtubeCount('0'),0);assert.equal(youtubeCount('-1'),null);assert.equal(youtubeCount('NaN'),null);
 assert.equal(requests,6);
 console.log('PASS: public/private reconciliation; exact vs missing counts; restrictions; latest snapshot; pagination; disconnect isolation; collector freshness; admin/preview permissions. No external requests or uploads.');
} finally {
 globalThis.fetch=originalFetch;await db?.close();
 if(created){assert.match(name,/^clipforge_analytics_qa_[a-f0-9]{32}$/);psql('DROP DATABASE "'+name+'" WITH (FORCE)');}
}
