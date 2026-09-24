// Runs only in the disposable GitHub container test database. No provider requests escape this process.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createContext} from '../apps/worker/dist/context.js';
import {PlatformsService} from '../apps/api/dist/platforms/platforms.service.js';
import {collectMetrics} from '../apps/worker/dist/metrics.js';
import {publishClip} from '../apps/worker/dist/publish.js';
import {pruneYoutubeData,forgetYoutubeAccount,youtubeDerivedMetricsAllowed,sanitizeRestoredYoutubeData} from '../packages/db/dist/index.js';
assert.match(new URL(process.env.DATABASE_URL).hostname,/^clipforge-test-db-/,'Disposable CI database required');
const ctx=createContext(),db=ctx.db;
const prefix=`audit-test-${randomUUID()}`;
const channel=`channel-${prefix}`,account=`account-${prefix}`,clip=`clip-${prefix}`;
const original=globalThis.fetch;
let failure=null,revokeFailure=false,uploads=0,captured,interrupted=false;
const queued=[];
const app={clientId:'test-client',clientSecret:'test-secret'};
const service=new PlatformsService(db,{youtube:app,apiOrigin:'http://localhost',webOrigin:'http://localhost'}, {enqueue:async(name,payload)=>queued.push(payload)});
const testCtx={...ctx,youtube:app,storage:{openVideo:async()=>({body:Readable.from([Buffer.from('video')]),size:5}),openVideoRange:async(key,offset)=>{assert.equal(offset,2);return Readable.from([Buffer.from('deo')]);}}};
globalThis.fetch=async(url,init)=>{
  const address=String(url);
  if(address.startsWith('http://127.0.0.1:8420/'))return original(url,init);
  if(address==='https://oauth2.googleapis.com/revoke')return revokeFailure?new Response('',{status:503}):new Response('');
  if(failure)return Response.json({error:failure},{status:failure==='invalid_grant'?400:503});
  if(address==='https://oauth2.googleapis.com/token')return Response.json({access_token:'test-access'});
  if(address.includes('/channels?'))return Response.json({items:[{id:channel,snippet:{title:'Test channel'}}]});
  if(address.includes('/upload/youtube/') && init.method==='POST'){uploads++;captured=JSON.parse(init.body);return new Response('',{headers:{location:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test'}});}
  if(address.includes('upload_id=test')){
    if(init.headers['content-range']==='bytes */5')return new Response(null,{status:308,headers:{range:'bytes=0-1'}});
    const body=await new Response(init.body).text();
    if(!interrupted){interrupted=true;throw new Error('Simulated network loss after accepted bytes');}
    assert.equal(body,'deo');assert.equal(init.headers['content-range'],'bytes 2-4/5');return Response.json({id:'test-video'});
  }
  if(address.includes('/videos?'))return Response.json({items:[{id:'test-video',status:{uploadStatus:'processed',privacyStatus:'private'},statistics:{viewCount:'3',likeCount:'1',commentCount:'0'}}]});
  throw new Error(`Unmocked provider URL: ${address}`);
};
try{
  await db.sql`insert into streamers(login) values(${prefix})`;
  await db.sql`insert into vods(id,streamer) values(${prefix},${prefix})`;
  await db.sql`insert into runs(id,vod_id,streamer,out_dir) values(${prefix},${prefix},${prefix},'/unused')`;
  await db.sql`insert into clips(id,run_id,vod_id,streamer,segment_key,file,state,text,media_storage) values(${clip},${prefix},${prefix},${prefix},${prefix},'test.mp4','ready','Test clip',${JSON.stringify({videoKey:'test/video',posterKey:'test/poster'})}::jsonb)`;
  await db.sql`insert into platform_accounts(id,platform,external_id,label,credentials) values(${account},'youtube',${channel},'Test channel',${JSON.stringify({refreshToken:'test-refresh'})}::jsonb)`;
  const draft=await service.preview(clip);assert.equal(draft.accounts[0].id,account);assert.equal(draft.privacy,'private');
  const metadata={accountId:account,title:'Пинг -то  меньше , блядь!',description:'Точное описание\n\nСо второй строкой',privacy:'public'};
  const [a,b]=await Promise.all([service.publish(clip,metadata),service.publish(clip,metadata)]);
  assert.equal(a.publicationId,b.publicationId);assert.equal(queued.length,1);
  await assert.rejects(publishClip(testCtx,{publicationId:a.publicationId},{log:()=>{}}));
  assert.equal((await db.sql`select * from youtube_upload_sessions where publication_id=${a.publicationId}`).length,1);
  await assert.rejects(service.publish(clip,{...metadata,title:'Changed during upload'}));
  await service.publish(clip,metadata);
  await publishClip(testCtx,{publicationId:a.publicationId},{log:()=>{}});
  assert.equal((await db.sql`select * from youtube_upload_sessions where publication_id=${a.publicationId}`).length,0);
  assert.equal(captured.snippet.title,'Пинг-то меньше, б****!');assert.equal(captured.snippet.description,metadata.description);assert.equal(captured.status.privacyStatus,'public');assert.equal(uploads,1);
  const [published]=await db.sql`select privacy,status,title,caption from publications where id=${a.publicationId}`;
  assert.equal(published.title,captured.snippet.title);assert.equal(published.caption,captured.snippet.description);
  assert.equal(published.privacy,'private');assert.equal(published.status,'uploaded','Requested public is not proof of actual public visibility');
  await collectMetrics(testCtx);
  assert.equal((await db.sql`select * from publication_metrics where publication_id=${a.publicationId}`).length,1);
  failure='unavailable';await collectMetrics(testCtx);
  assert.equal((await service.accounts()).length,1,'An outage must not erase consent');failure=null;
  await db.sql`insert into publication_metrics(id,publication_id,collected_at,views) values(${prefix},${a.publicationId},now()-interval '22 days',999),(${prefix+'-recent'},${a.publicationId},now()-interval '20 days',100)`;
  await pruneYoutubeData(db);assert.equal((await db.sql`select id from publication_metrics where id=${prefix}`).length,0);
  assert.equal((await db.sql`select id from publication_metrics where id=${prefix+'-recent'}`).length,1,'Recent history remains available');
  assert.equal(await youtubeDerivedMetricsAllowed(db),false);
  for(const role of ['admin','moderator','user']){
    const id=`${prefix}-${role}`,token=randomUUID();
    await db.sql`insert into accounts(id,login,password_hash,role,streamer) values(${id},${id},'test-only',${role},${prefix})`;
    await db.sql`insert into sessions(token,account_id,expires_at) values(${token},${id},now()+interval '10 minutes')`;
    const request=path=>fetch(`http://127.0.0.1:8420${path}`,{headers:{cookie:`clipforge_session=${token}`}});
    const detail=await (await request(`/api/clips/${clip}`)).json();
    assert.equal('file' in detail,role==='admin');assert.equal('account' in detail.publications[0],role==='admin');
    const ops=await (await request('/api/operations')).json();assert.equal('runtime' in ops,role==='admin');
    assert.equal((await request(`/api/platforms/publish/${clip}`)).status,role==='admin'?200:403);
    const denied=await fetch(`http://127.0.0.1:8420/api/platforms/publish/${clip}`,{method:'POST',headers:{cookie:`clipforge_session=${token}`,'content-type':'application/json'},body:'{}'});
    assert.equal(denied.status,role==='admin'?400:403);
  }
  revokeFailure=true;assert.equal((await service.disconnect(account)).state,'pending');
  assert.equal((await db.sql`select * from publication_metrics where publication_id=${a.publicationId}`).length,0,'Display data removed before provider revocation succeeds');
  assert.equal((await service.accounts())[0].label,'','Pending disconnect does not keep the channel title');
  await assert.rejects(service.publish(clip,metadata));
  assert.equal((await service.preview(clip)).accounts.length,0);
  revokeFailure=false;await collectMetrics(testCtx);
  assert.equal((await service.accounts()).length,0);assert.equal((await db.sql`select * from publication_metrics where publication_id=${a.publicationId}`).length,0);
  const [tombstone]=await db.sql`select * from publications where id=${a.publicationId}`;
  assert.equal(tombstone.status,'takedown');for(const field of ['mediaId','url','operationId','title','caption','privacy'])assert.equal(tombstone[field],null);
  assert.equal((await db.sql`select * from clips where id=${clip}`).length,1,'Disconnect preserves source clips');
  await forgetYoutubeAccount(db,account);
  await db.sql`insert into platform_accounts(id,platform,external_id,credentials) values(${account},'youtube',${channel},${JSON.stringify({refreshToken:'revoked'})}::jsonb)`;
  failure='invalid_grant';await collectMetrics(testCtx);assert.equal((await service.accounts()).length,0,'Revoked consent cleared even with no videos');
  await db.sql`insert into platform_accounts(id,platform,external_id,credentials,verified_at,created_at) values(${account},'youtube',${channel},${JSON.stringify({refreshToken:'unverifiable'})}::jsonb,now()-interval '22 days',now()-interval '22 days')`;
  failure='unavailable';await collectMetrics(testCtx);
  assert.equal((await service.accounts()).length,0,'Expired verification leaves room for backup retention');
  await db.sql`insert into platform_accounts(id,platform,external_id,credentials,disconnect_requested_at) values(${account},'youtube',${channel},${JSON.stringify({refreshToken:'pending'})}::jsonb,now()-interval '13 hours')`;
  revokeFailure=true;await collectMetrics(testCtx);
  assert.equal((await service.accounts()).length,0,'Revocation retries cannot retain credentials beyond 12 hours plus polling');
  await db.sql`insert into platform_accounts(id,platform,external_id,credentials) values(${account},'youtube',${channel},${JSON.stringify({refreshToken:'restored-token'})}::jsonb)`;
  await db.sql`update publications set account=${channel},media_id='restored-video',url='https://youtube.com/watch?v=restored-video',title='Restored title',privacy='private',status='uploaded' where id=${a.publicationId}`;
  await db.sql`insert into publication_metrics(id,publication_id,views) values(${prefix+'-restored'},${a.publicationId},10)`;
  await sanitizeRestoredYoutubeData(db);await sanitizeRestoredYoutubeData(db);
  assert.equal((await service.accounts()).length,0);
  assert.equal((await db.sql`select * from publication_metrics where publication_id=${a.publicationId}`).length,0);
  const [restored]=await db.sql`select * from publications where id=${a.publicationId}`;
  assert.equal(restored.mediaId,null);assert.equal(restored.title,null);assert.equal(restored.status,'takedown');
  assert.equal((await db.sql`select * from clips where id=${clip}`).length,1);
  assert.equal((await db.sql`select * from accounts where id=${prefix+'-admin'}`).length,1,'Restore sanitizer preserves platform login');
  const [settings]=await db.sql`select value from platform_runtime where key='settings'`;
  assert.equal(settings.value.paused,true);assert.equal(settings.value.developmentMode,true);
  console.log('PASS: exact upload metadata, duplicate enqueue, actual visibility, immediate deletion during revoke outages, bounded retries, backup-aware retention, offline restore sanitization and role isolation');
}finally{
  globalThis.fetch=original;
  await db.sql`delete from accounts where id in (${prefix+'-admin'},${prefix+'-moderator'},${prefix+'-user'})`;
  await db.sql`delete from platform_accounts where id=${account}`;
  await db.sql`delete from streamers where login=${prefix}`;
  await ctx.close();
}
