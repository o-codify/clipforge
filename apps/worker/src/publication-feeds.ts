import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import {QUEUES,batchPublicationKey,type PublicationFeed,type BatchPublicationPolicy} from '@clipforge/jobs';
import type {Context} from './context.js';
import {gameWindows} from './game-selection.js';
import {uploadWait} from './upload-quota.js';

type Window={jobId:string;vodId:string;start:number;end:number;state:'reserved'|'submitted'|'done'|'failed';createdAt:string;error?:string;attempt?:number;retryAt?:string|null};
// Queue retries handle brief interruptions. Exhausted windows get two delayed
// attempts, without preventing other ranges or future broadcasts from running.
const RETRY_DELAYS=[3600000,6*3600000];
type Source={id:string;chapters:{title:string;start:number;end:number}[]};
// Fifteen-minute work units bound memory and downloads, not the number of clips
// or broadcasts in a feed. Finished windows persist beyond pg-boss retention.
export function feedWindows(sources:Source[],game:string,initial?:{startVodId:string;startOffsetSeconds?:number}){
  return sources.flatMap(v=>gameWindows(v.chapters,game).flatMap(c=>{
    const ranges:{vodId:string;start:number;end:number}[]=[];
    const first=v.id===initial?.startVodId?Math.max(c.start,initial.startOffsetSeconds??0):c.start;
    for(let start=first;start<c.end;start+=900)if(c.end-start>=15)ranges.push({vodId:v.id,start,end:Math.min(c.end,start+900)});
    return ranges;
  }));
}
const windowKey=(id:string,w:{vodId:string;start:number;end:number})=>`feed-window:${id}:${w.vodId}:${w.start}:${w.end}`;

export async function replenishPublicationFeeds(ctx:Context,boss:Pick<PgBoss,'send'|'createQueue'>){
  await boss.createQueue(QUEUES.preparePreview);
  const feeds=await ctx.db.execute<{key:string}>(sql`select key from platform_runtime where key like 'publication-feed:%' and value->>'enabled'='true' order by key`);
  for(const entry of feeds){
    const next=await ctx.db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(740025)`);
      const [row]=await tx.execute<{value:PublicationFeed}>(sql`select value from platform_runtime where key=${entry.key} for update`);
      if(!row?.value.enabled)return null;
      const p=row.value;
      // Active publication sources take precedence over discovery of unrelated
      // channels; otherwise a large catalog backlog can starve a live feed.
      await tx.execute(sql`update jobs.job set priority=5 where name=${QUEUES.indexChannel}
        and data->>'login'=${p.login} and state in ('created','retry') and priority<5`);
      let saved:{key:string;value:Window}[]=[];
      const state=async(value:string,error:string|null=null)=>{
        const failed=saved.filter(s=>s.value.state==='failed');
        const nextRetryAt=failed.map(s=>s.value.retryAt).filter((at):at is string=>typeof at==='string').sort()[0]??null;
        await tx.execute(sql`update platform_runtime set value=value||${JSON.stringify({state:value,error,deferredWindows:failed.length,nextRetryAt})}::jsonb,updated_at=now() where key=${entry.key}`);
      };
      const [account]=await tx.execute(sql`select 1 from platform_accounts where platform='youtube' and external_id=${p.channelId} and disconnect_requested_at is null and credentials->>'refreshToken' is not null`);
      if(!account){await state('waiting-channel');return null;}
      saved=await tx.execute<{key:string;value:Window}>(sql`select key,value from platform_runtime where key like ${'feed-window:'+p.id+':%'} order by key`);
      const save=async(item:{key:string;value:Window})=>tx.execute(sql`update platform_runtime set value=${JSON.stringify(item.value)}::jsonb,updated_at=now() where key=${item.key}`);
      // Upgrade retained failures from releases which stopped the entire feed.
      for(const item of saved.filter(s=>s.value.state==='failed'&&s.value.retryAt===undefined)){
        item.value.attempt=1;item.value.retryAt=new Date().toISOString();await save(item);
      }
      for(const item of saved.filter(w=>w.value.state!=='done'&&w.value.state!=='failed')){
        const w=item.value;
        const [job]=await tx.execute<{state:string;output:{message?:string}|null}>(sql`select state,output from jobs.job where id=${w.jobId}::uuid`);
        const completed=job?.state==='completed'||(!job&&(await tx.execute(sql`select 1 from runs where settings->>'jobId'=${w.jobId} and finished_at is not null
          union all select 1 from remote_worker_leases where job_id=${w.jobId}::uuid and state='completed' limit 1`)).length>0);
        if(completed||job?.state==='failed'&&/Нет новых моментов/.test(job.output?.message??'')){
          w.state='done';await tx.execute(sql`update platform_runtime set value=${JSON.stringify(w)}::jsonb,updated_at=now() where key=${item.key}`);continue;
        }
        if(job&&['failed','cancelled'].includes(job.state)||!job&&w.state==='submitted'&&Date.now()-Date.parse(w.createdAt)>6*3600000){
          w.state='failed';w.error=job?.output?.message??'Обработка остановлена';
          w.attempt??=1;const delay=RETRY_DELAYS[w.attempt-1];
          w.retryAt=delay===undefined?null:new Date(Date.now()+delay).toISOString();
          await save(item);continue;
        }
        if(job){await state('preparing');return null;}
        if(w.state==='reserved'){await state('preparing');return {key:item.key,window:w,feed:p};}
        await state('preparing');return null;
      }
      const failed=saved.filter(w=>w.value.state==='failed');
      const nextRetryAt=failed.map(w=>w.value.retryAt).filter((at):at is string=>typeof at==='string').sort()[0]??null;
      const [queued]=await tx.execute<{n:number}>(sql`select count(*)::int n from clips c join runs r on r.id=c.run_id
        join platform_runtime b on b.key='batch-publication:'||(r.settings->>'jobId')
        where b.value->>'feedId'=${p.id} and c.archived_at is null and c.state in ('draft','ready')
        and not exists(select 1 from publications u where u.clip_id=c.id and u.platform='youtube' and u.account=${p.channelId} and u.media_id is not null)`);
      // Keep a useful buffer and refill it as each video is published.
      if((queued?.n??0)>=20){await state('buffer-ready');return null;}
      const wait=await uploadWait(tx,p.channelId);
      if(wait&&(queued?.n??0)>0){await state('youtube-limit',wait.message);return null;}
      const sources=await tx.execute<Source>(sql`select id,chapters from vods where streamer=${p.login}
        and published_at>=${p.since}::timestamptz and duration>15 and jsonb_array_length(chapters)>0 order by published_at desc,id`);
      const available=feedWindows(sources,p.game,p).find(w=>!saved.some(s=>s.key===windowKey(p.id,w)));
      const retry=failed.find(s=>s.value.retryAt&&Date.parse(s.value.retryAt)<=Date.now());
      if(!available&&!retry){await state(failed.length?(nextRetryAt?'waiting-retry':'needs-attention'):'waiting-streams',failed[0]?.value.error??null);return null;}
      const w:Window={...(available??retry!.value),jobId:randomUUID(),state:'reserved',createdAt:new Date().toISOString(),
        attempt:available?1:(retry!.value.attempt??1)+1,error:undefined,retryAt:undefined},key=windowKey(p.id,w);
      const policy:BatchPublicationPolicy={jobId:w.jobId,login:p.login,channelId:p.channelId,enabled:true,intervalMinutes:p.intervalMinutes,
        dailyLimit:null,privacy:'public',authorizedAt:p.authorizedAt,state:'waiting-clips',feedId:p.id,game:p.game};
      await tx.execute(sql`insert into platform_runtime(key,value) values(${key},${JSON.stringify(w)}::jsonb)
        on conflict(key) do update set value=excluded.value,updated_at=now()`);
      await tx.execute(sql`insert into platform_runtime(key,value) values(${batchPublicationKey(w.jobId)},${JSON.stringify(policy)}::jsonb)`);
      if(!available&&retry)retry.value=w;
      await state('preparing');return {key,window:w,feed:p};
    });
    if(!next)continue;
    const {window:w,feed:p}=next;
    const payload={vodId:w.vodId,game:p.game,sourceRange:{start:w.start,end:w.end},audioMode:p.audioMode,count:100,skipExisting:true,testBatch:true,reuse:true};
    // Fixed IDs make a crash between reservation/send/ack idempotent.
    const sent=await boss.send(QUEUES.preparePreview,payload,{id:w.jobId,singletonKey:next.key,priority:5,retryLimit:2,retryDelay:60,retryBackoff:true,expireInSeconds:6*3600});
    if(sent||(await ctx.db.execute(sql`select 1 from jobs.job where id=${w.jobId}::uuid`)).length)
      await ctx.db.execute(sql`update platform_runtime set value=jsonb_set(value,'{state}','"submitted"'::jsonb),updated_at=now() where key=${next.key} and value->>'state'='reserved'`);
  }
}
