import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationWindow,publishBatchClip,dispatchBatchPublications} from '../dist/batch-publication.js';
import {PgDialect} from 'drizzle-orm/pg-core';
import {servesQueue} from '../dist/routing.js';
import {QUEUES,batchPublicationOptions} from '@clipforge/jobs';

const now=Date.UTC(2026,8,30,12),minute=60000;
test('new batch publishes immediately, recent manual upload imposes spacing',()=>{
  assert.equal(publicationWindow(now,10,100,[]).due,true);
  const waiting=publicationWindow(now,10,100,[now-3*minute]);
  assert.equal(waiting.due,false);
  assert.equal(waiting.nextAt,new Date(now+7*minute).toISOString());
});
test('rolling allowance counts all attempts and waits until a slot opens',()=>{
  const dates=Array.from({length:100},(_,i)=>now-(i+1)*minute);
  const window=publicationWindow(now,10,100,dates);
  assert.equal(window.reason,'daily-limit');assert.equal(window.due,false);
  assert.equal(window.nextAt,new Date(now+1340*minute).toISOString());
  assert.equal(publicationWindow(now+24*60*minute,10,100,dates).due,true);
});
test('restart never collapses future spacing or queues the entire backlog',()=>{
  const future=new Date(now+10*minute).toISOString();
  assert.equal(publicationWindow(now,10,100,[],future).due,false);
  assert.equal(publicationWindow(now+10*minute,10,100,[],future).due,true);
});
test('publication and batch coordination stay on the platform; media workers only process assigned VODs',()=>{
  assert.equal(QUEUES.publishBatchClip.startsWith('heavy.'),false);
  assert.equal(servesQueue('media',QUEUES.publishBatchClip),false);
  assert.equal(servesQueue('control',QUEUES.publishBatchClip),true);
  assert.equal(servesQueue('media',QUEUES.prepareStreamer),false);
  assert.equal(servesQueue('control',QUEUES.prepareStreamer),true);
});
test('paused, cancelled, and stale queued jobs cannot publish',async()=>{
  for(const row of [undefined,{value:{enabled:false}},{value:{enabled:true},cancelled:true},
    {value:{enabled:true,pendingPublicationId:'different'}}]) {
    const ctx={db:{execute:async()=>row?[row]:[]}};
    const result=await publishBatchClip(ctx,{batchId:'id',publicationId:'p'},{});
    assert.equal(result.message,'Публикация приостановлена');
  }
});
test('publication scope and rate must be explicit and bounded',()=>{
  const valid={enabled:true,channelId:'UC-P-55QVYfT8SBtGnCNAtog'};
  assert.equal(batchPublicationOptions.parse(valid).intervalMinutes,10);
  assert.equal(batchPublicationOptions.safeParse({...valid,dailyLimit:101}).success,false);
  assert.equal(batchPublicationOptions.safeParse({...valid,intervalMinutes:0}).success,false);
  assert.equal(batchPublicationOptions.safeParse({enabled:true}).success,false);
});

function fixture({connected=true,sendFails=false,block=null,quota=null}={}) {
  const jobId='097c3667-a92b-4eba-9393-4fd84bb2b83b';
  let policy={jobId,login:'sany',enabled:true,channelId:'UC-P-55QVYfT8SBtGnCNAtog',intervalMinutes:10,dailyLimit:100,privacy:'public'};
  const pubs=[],sent=[],jobs=[];let candidates=2;
  const dialect=new PgDialect();
  const db={transaction:async fn=>fn(db),execute:async statement=>{
    const {sql:query,params:p}=dialect.sqlToQuery(statement);const q=query.replace(/\s+/g,' ').trim();
    if(q.includes('pg_advisory_xact_lock'))return [];
    if(q.startsWith('select key,value'))return [{key:'batch-publication:'+jobId,value:structuredClone(policy)}];
    if(q.startsWith('update platform_runtime')){policy=JSON.parse(p[0]);return [];}
    if(q.startsWith('select state from jobs.job'))return [{state:'active'}];
    if(q.startsWith('select id from platform_accounts'))return connected?[{id:'account'}]:[];
    if(q.startsWith('select value from platform_runtime'))return q.includes("key='youtube-quota'")?(quota?[{value:quota}]:[]):block?[{value:block}]:[];
    if(q.startsWith('select count(*)::int n from platform_runtime'))return [{n:0}];
    if(q.startsWith('select status,media_id'))return pubs.filter(row=>row.id===p[0]);
    if(q.startsWith('select id from publications'))return pubs.filter(row=>['queued','uploading','processing'].includes(row.status));
    if(q.startsWith('select created_at'))return [];
    if(q.startsWith('select c.id,c.streamer')){
      assert.ok(p.includes(jobId)&&p.includes('sany'),'scope is the approved batch, never all streamer drafts');
      assert.match(q,/c\.state in \('draft','ready'\)/);assert.match(q,/autoVerifiedAt/);assert.match(q,/disabledAt/);
      return candidates?[{id:'clip-'+candidates,login:'sany',displayName:'Sany',gameTitle:'Dota 2'}]:[];
    }
    if(q.startsWith('update clips'))return [];
    if(q.startsWith('insert into publications')){pubs.push({id:p[0],status:'queued',mediaId:null,error:null});candidates--;return [];}
    if(q.startsWith('select id from jobs.job'))return jobs.filter(j=>p.includes(j.key));
    throw new Error('Unmocked SQL: '+q);
  }};
  const boss={send:async(name,data,options)=>{
    if(sendFails){sendFails=false;throw new Error('queue disconnected after commit');}
    sent.push(data);jobs.push({key:options.singletonKey});return 'queue-job';
  }};
  return {ctx:{db},boss,pubs,sent,policy:()=>policy};
}

test('active render batch publishes incrementally, one outstanding upload, then waits full interval',async()=>{
  const f=fixture();
  await dispatchBatchPublications(f.ctx,f.boss,now);
  assert.equal(f.sent.length,1);assert.equal(f.pubs.length,1);
  await dispatchBatchPublications(f.ctx,f.boss,now+minute);
  assert.equal(f.sent.length,1);assert.equal(f.pubs.length,1);
  f.pubs[0].status='published';f.pubs[0].mediaId='video';
  await dispatchBatchPublications(f.ctx,f.boss,now+2*minute);
  await dispatchBatchPublications(f.ctx,f.boss,now+11*minute);
  assert.equal(f.pubs.length,1);
  await dispatchBatchPublications(f.ctx,f.boss,now+12*minute);
  assert.equal(f.pubs.length,2);assert.equal(f.sent.length,2);
});
test('committed outbox survives queue failure without a duplicate publication',async()=>{
  const f=fixture({sendFails:true});
  await assert.rejects(dispatchBatchPublications(f.ctx,f.boss,now));
  assert.equal(f.pubs.length,1);
  await dispatchBatchPublications(f.ctx,f.boss,now+minute);
  assert.equal(f.pubs.length,1);assert.equal(f.sent.length,1);
});
test('disconnected channel creates no upload and keeps a visible waiting state',async()=>{
  const f=fixture({connected:false});
  await dispatchBatchPublications(f.ctx,f.boss,now);
  assert.equal(f.policy().state,'waiting-channel');assert.equal(f.pubs.length,0);assert.equal(f.sent.length,0);
});

test('known provider limit stops new uploads but records a completed pending upload',async()=>{
  const f=fixture({block:{until:new Date(now+3600000).toISOString(),reason:'project-quota'}});
  await dispatchBatchPublications(f.ctx,f.boss,now);
  assert.equal(f.policy().state,'youtube-limit');assert.equal(f.sent.length,0);
  const active=fixture();await dispatchBatchPublications(active.ctx,active.boss,now);
  active.pubs[0].status='published';active.pubs[0].mediaId='video';
  await dispatchBatchPublications(active.ctx,active.boss,now+minute);
  assert.equal(active.policy().pendingPublicationId,null);assert.equal(active.policy().state,'interval');
});
