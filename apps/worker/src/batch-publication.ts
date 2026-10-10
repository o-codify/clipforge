import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import {enqueueUnique} from '@clipforge/db';
import {QUEUES,singletonKey,batchPublicationKey,type BatchPublicationPolicy,type PayloadOf} from '@clipforge/jobs';
import {prepareVideoMetadata,suggestVideoMetadata,validateVideoMetadata} from '@clipforge/youtube';
import type {Context} from './context.js';
import type {JobReport} from './handlers.js';
import {publishClip} from './publish.js';
import {uploadWait} from './upload-quota.js';
import {replenishPublicationFeeds} from './publication-feeds.js';

export function publicationWindow(now:number,intervalMinutes:number,dailyLimit:number|null,recentDates:number[],nextAt?:string|null) {
  const recent=recentDates.filter(at=>at>now-24*3600_000).sort((a,b)=>a-b);
  const spacing=recent.length?recent.at(-1)!+intervalMinutes*60_000:0;
  const cap=dailyLimit!==null&&recent.length>=dailyLimit?recent[recent.length-dailyLimit]!+24*3600_000:0;
  const at=Math.max(spacing,cap,nextAt?Date.parse(nextAt):0);
  return {due:at<=now,nextAt:new Date(Math.max(now,at)).toISOString(),reason:cap>now?'daily-limit':'interval'};
}

/** One durable outbox entry per batch, and one queue job per clip. The render
 * job may still be running or retrying; no batch-completion gate exists here. */
export async function dispatchBatchPublications(ctx:Context,boss:Pick<PgBoss,'send'>,now=Date.now()) {
  const pending=await ctx.db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(740025)`);
    const policies=await tx.execute<{key:string;value:BatchPublicationPolicy}>(sql`select key,value from platform_runtime
      where key like 'batch-publication:%' and value->>'enabled'='true' order by updated_at for update`);
    const outbox:{batchId:string;publicationId:string}[]=[];
    for(const row of policies) {
      const p=row.value;
      const save=async(state:string,error:string|null=null)=>{
        p.state=state;p.error=error;
        await tx.execute(sql`update platform_runtime set value=${JSON.stringify(p)}::jsonb,updated_at=now() where key=${row.key}`);
      };
      const [job]=await tx.execute<{state:string}>(sql`select state from jobs.job where id=${p.jobId}::uuid`);
      if(job?.state==='cancelled'){p.enabled=false;await save('paused');continue;}
      const [account]=await tx.execute<{id:string}>(sql`select id from platform_accounts where platform='youtube'
        and external_id=${p.channelId} and disconnect_requested_at is null and credentials->>'refreshToken' is not null for update`);
      if(!account){await save('waiting-channel');continue;}
      if(p.pendingPublicationId) {
        const [pub]=await tx.execute<{status:string;mediaId:string|null;error:string|null}>(sql`select status,media_id as "mediaId",error from publications where id=${p.pendingPublicationId}`);
        if(pub?.status==='failed'&&!pub.mediaId&&/youtube upload init.*(?:quotaExceeded|dailyLimitExceeded|uploadLimitExceeded)|\[quota-wait\]/s.test(pub.error??'')){
          const wait=await uploadWait(tx,p.channelId,now);
          if(wait){p.nextAt=wait.until;await save('youtube-limit',wait.message);continue;}
          // Only an explicitly rejected init can be retried automatically. Never an uncertain body upload.
          const session=await tx.execute(sql`select publication_id from youtube_upload_sessions where publication_id=${p.pendingPublicationId}`);
          if(!session.length){
            await tx.execute(sql`update publications set status='queued',error=null,updated_at=now() where id=${p.pendingPublicationId}`);
            pub.status='queued';p.nextAt=null;
          }
        }
        if(!pub||['failed','takedown'].includes(pub.status)){await save('error',pub?.error??'Публикация остановлена');continue;}
        if(['uploaded','published'].includes(pub.status)) {
          p.pendingPublicationId=null;p.nextAt=new Date(now+p.intervalMinutes*60_000).toISOString();
          await save('interval');continue;
        }
        if(pub.status==='uploading') {
          const active=await tx.execute(sql`select id from jobs.job where name=${QUEUES.publishBatchClip}
            and data->>'publicationId'=${p.pendingPublicationId} and state in ('created','active','retry') limit 1`);
          if(!active.length) {
            const session=await tx.execute(sql`select publication_id from youtube_upload_sessions where publication_id=${p.pendingPublicationId}`);
            if(!session.length){await save('error','Исход загрузки неизвестен. Проверьте ролик на YouTube.');continue;}
            await tx.execute(sql`update publications set status='queued',updated_at=now() where id=${p.pendingPublicationId}`);
            pub.status='queued';
          }
        }
        if(pub.status==='queued') {
          const wait=await uploadWait(tx,p.channelId,now);
          if(wait){p.nextAt=wait.until;await save('youtube-limit',wait.message);continue;}
          outbox.push({batchId:p.jobId,publicationId:p.pendingPublicationId});
        }
        await save('uploading');continue;
      }
      const wait=await uploadWait(tx,p.channelId,now);
      if(wait){p.nextAt=wait.until;await save('youtube-limit',wait.message);continue;}
      const active=await tx.execute(sql`select id from publications where platform='youtube' and account=${p.channelId}
        and status in ('queued','uploading','processing') limit 1`);
      if(active.length){await save('waiting-upload');continue;}
      // Count actual init attempts, including retries of an older publication.
      // The same channel shares spacing across every batch and manual upload.
      const recent=await tx.execute<{at:Date}>(sql`select updated_at as at from platform_runtime
        where key like 'upload-attempt:%' and value->>'channel'=${p.channelId} and updated_at>now()-interval '24 hours'`);
      const window=publicationWindow(now,p.intervalMinutes,p.dailyLimit,recent.map(r=>new Date(r.at).getTime()),p.nextAt);
      if(!window.due){p.nextAt=window.nextAt;await save(window.reason);continue;}
      const [clip]=await tx.execute<{id:string;login:string;displayName:string|null;gameTitle:string|null}>(sql`
        select c.id,c.streamer as login,s.display_name as "displayName",g.title as "gameTitle"
        from clips c join runs r on r.id=c.run_id join streamers s on s.login=c.streamer left join games g on g.slug=c.game
        where r.settings->>'jobId'=${p.jobId} and c.streamer=${p.login} and c.archived_at is null and c.media_released_at is null and c.state in ('draft','ready')
          ${p.game?sql`and c.game=${p.game}`:sql``}
          and coalesce(r.settings #>> array['renderedClips',c.id,'protection','autoVerifiedAt'],
            r.settings #>> array['renderedClips',c.id,'protection','reviewedAt'],
            r.settings #>> array['renderedClips',c.id,'protection','disabledAt']) is not null
          and not exists(select 1 from publications u where u.clip_id=c.id and u.platform='youtube' and u.account=${p.channelId})
        order by c.created_at,c.id limit 1 for update of c`);
      if(!clip){await save(job?.state==='completed'?'completed':'waiting-clips');continue;}
      const metadata=prepareVideoMetadata({...suggestVideoMetadata({...clip,displayName:clip.displayName??clip.login}),privacy:p.privacy});
      validateVideoMetadata(metadata);
      const publicationId=randomUUID();
      await tx.execute(sql`update clips set state='ready' where id=${clip.id}`);
      await tx.execute(sql`insert into publications(id,clip_id,platform,account,status,privacy,title,caption,scheduled_at)
        values(${publicationId},${clip.id},'youtube',${p.channelId},'queued',${p.privacy},${metadata.title},${metadata.description},now())`);
      p.pendingPublicationId=publicationId;p.nextAt=null;
      await save('uploading');outbox.push({batchId:p.jobId,publicationId});
    }
    return outbox;
  });
  // Crash between commit and send is recovered from pendingPublicationId.
  for(const data of pending) {
    const key=singletonKey(QUEUES.publishBatchClip,data);
    await enqueueUnique(ctx.db,QUEUES.publishBatchClip,key,()=>boss.send(QUEUES.publishBatchClip,data,
      {singletonKey:key,retryLimit:0,expireInSeconds:3600}));
  }
}

export async function publishBatchClip(ctx:Context,payload:PayloadOf<typeof QUEUES.publishBatchClip>,report:JobReport) {
  const [row]=await ctx.db.execute<{value:BatchPublicationPolicy;cancelled:boolean}>(sql`select r.value,
    exists(select 1 from jobs.job j where j.id=${payload.batchId}::uuid and j.state='cancelled') as cancelled
    from platform_runtime r where key=${batchPublicationKey(payload.batchId)}`);
  if(!row?.value.enabled||row.cancelled||row.value.pendingPublicationId!==payload.publicationId) return {message:'Публикация приостановлена'};
  try { return await publishClip(ctx,payload,report); }
  catch(error) {
    // No blind retry: uncertain uploads and quota/account failures stop this batch.
    await ctx.db.execute(sql`update publications set status='failed',error=coalesce(error,${String(error).slice(0,500)}),updated_at=now()
      where id=${payload.publicationId} and media_id is null and status<>'takedown'`);
    throw error;
  }
}

export function startBatchPublications(ctx:Context,boss:Pick<PgBoss,'send'|'createQueue'>) {
  let busy=false,stopped=false;
  const tick=async()=>{if(busy||stopped)return;busy=true;try{
    try{await replenishPublicationFeeds(ctx,boss);}catch(e){ctx.log(`Пополнение публикаций: ${String(e)}`);}
    await dispatchBatchPublications(ctx,boss);
  }catch(e){ctx.log(`Публикация подборки: ${String(e)}`);}finally{busy=false;}};
  const timer=setInterval(()=>void tick(),30_000);void tick();
  return ()=>{stopped=true;clearInterval(timer);};
}
