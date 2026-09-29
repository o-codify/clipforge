import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { platformAccounts, publications, publicationMetrics, runtimeValue, forgetYoutubeAccount, clearYoutubePublications, pruneYoutubeData, YOUTUBE_DATA_RETENTION_DAYS, YOUTUBE_REVOCATION_RETRY_HOURS } from "@clipforge/db";
import { refreshAccessToken, videoSnapshots, myChannel, revokeToken, YoutubeAccessRevokedError } from "@clipforge/youtube";
import type { Context } from "./context.js";
import type { PayloadOf } from '@clipforge/jobs';
import type { JobReport } from './handlers.js';

/** An absent/hidden counter is not a measured zero. */
export function youtubeCount(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count <= 2147483647 ? count : null;
}

/** Reconciles actual visibility and authorization, including channels with no uploads. */
export async function collectMetrics(ctx: Context, publicationId?: string) {
  // Manual, scheduled and post-upload checks share one lock across processes.
  const connection = await ctx.db.sql.reserve();
  let locked = false;
  try {
    const [lock] = await connection`select pg_try_advisory_lock(740024) as locked`;
    locked = !!lock?.locked;
    if (!locked) return { state:'busy' as const, collected:0, failed:0 };
    return await collectUnlocked(ctx, publicationId);
  } finally {
    if (locked) await connection`select pg_advisory_unlock(740024)`;
    connection.release();
  }
}

async function collectUnlocked(ctx: Context, publicationId?: string) {
  await pruneYoutubeData(ctx.db);
  const accounts=await ctx.db.select().from(platformAccounts).where(and(eq(platformAccounts.platform,"youtube"),
    publicationId ? sql`exists (select 1 from publications p where p.id=${publicationId} and p.account=${platformAccounts.externalId} and p.platform='youtube')` : undefined));
  let collected=0,failed=0;
  for(const account of accounts){
    if(account.disconnectRequestedAt){
      try{
        if(account.credentials.refreshToken)await revokeToken(account.credentials.refreshToken);
        await forgetYoutubeAccount(ctx.db,account.id);
      }catch{
        failed++;
        if(Date.now()-account.disconnectRequestedAt.getTime()>YOUTUBE_REVOCATION_RETRY_HOURS*3600000)await forgetYoutubeAccount(ctx.db,account.id);
      }
      continue;
    }
    try{
      if(!ctx.youtube||!account.credentials.refreshToken)throw new Error("Подключение недоступно");
      const token=await refreshAccessToken(ctx.youtube,account.credentials.refreshToken);
      const channel=await myChannel(token);
      if(channel?.id!==account.externalId)throw new YoutubeAccessRevokedError();
      const saved=await ctx.db.update(platformAccounts).set({verifiedAt:new Date(),label:channel.title})
        .where(and(eq(platformAccounts.id,account.id),isNull(platformAccounts.disconnectRequestedAt))).returning({id:platformAccounts.id});
      if(!saved.length)continue;
      const rows=await ctx.db.select().from(publications).where(and(eq(publications.platform,"youtube"),eq(publications.account,account.externalId),sql`${publications.mediaId} is not null`,
        sql`${publications.status} <> 'takedown'`,publicationId ? eq(publications.id,publicationId) : undefined));
      for(let i=0;i<rows.length;i+=50){
        const batch=rows.slice(i,i+50);
        const snapshots=await videoSnapshots(token,batch.map(row=>row.mediaId!));
        await clearYoutubePublications(ctx.db,batch.filter(row=>!snapshots.some(snapshot=>snapshot.id===row.mediaId)).map(row=>row.id));
        for(const snapshot of snapshots){
          const row=batch.find(row=>row.mediaId===snapshot.id);
          if(!row)continue;
          await ctx.db.transaction(async tx=>{
            const [active]=await tx.select({id:platformAccounts.id}).from(platformAccounts)
              .where(and(eq(platformAccounts.id,account.id),isNull(platformAccounts.disconnectRequestedAt))).for("update");
            if(!active)return;
            const processed=snapshot.status.uploadStatus==="processed";
            const rejected=["rejected","failed","deleted"].includes(snapshot.status.uploadStatus);
            const isPublic=snapshot.status.privacyStatus==="public";
            const changed=await tx.update(publications).set({privacy:snapshot.status.privacyStatus,
              status:rejected?"failed":processed?isPublic?"published":"uploaded":"processing",
              publishedAt:processed&&isPublic?(snapshot.snippet?.publishedAt && Number.isFinite(Date.parse(snapshot.snippet.publishedAt))
                ? new Date(snapshot.snippet.publishedAt) : row.publishedAt??new Date()):null,
              error:rejected?snapshot.status.rejectionReason??snapshot.status.uploadStatus:null,updatedAt:new Date(),
            }).where(and(eq(publications.id,row.id),eq(publications.account,account.externalId),eq(publications.mediaId,snapshot.id))).returning({id:publications.id});
            if(!changed.length)return;
            await tx.insert(publicationMetrics).values({id:randomUUID(),publicationId:row.id,
              views:youtubeCount(snapshot.statistics?.viewCount),likes:youtubeCount(snapshot.statistics?.likeCount),comments:youtubeCount(snapshot.statistics?.commentCount),
              extended:{privacy:snapshot.status.privacyStatus,
                restrictionsChecked:!!snapshot.contentDetails,
                regionRestriction:snapshot.contentDetails?.regionRestriction??null,
                ageRestricted:snapshot.contentDetails ? snapshot.contentDetails.contentRating?.ytRating==='ytAgeRestricted' : null,
              },raw:{}});
            collected++;
          });
        }
      }
    }catch(error){
      failed++;
      if(error instanceof YoutubeAccessRevokedError || Date.now()-(account.verifiedAt??account.createdAt).getTime()>YOUTUBE_DATA_RETENTION_DAYS*86400000){
        await forgetYoutubeAccount(ctx.db,account.id);
      }
    }
  }
  const result = {state:failed?'error' as const:'ok' as const,collected,failed};
  // A check of one video must not claim that the entire catalog was refreshed.
  if (!publicationId) await runtimeValue(ctx.db,"metrics",result);
  return result;
}

export async function refreshYoutube(ctx:Context, payload:PayloadOf<'light.refresh-youtube'>, report:JobReport) {
  if (await report.cancelled()) return {cancelled:true};
  report.log('Проверяю видимость видео, ограничения и статистику YouTube');
  const result = await collectMetrics(ctx,payload.publicationId);
  if(result.state==='busy') throw new Error('Обновление уже выполняется. Повторим после паузы.');
  if(result.failed) throw new Error('Не удалось обновить данные YouTube. Проверьте подключение канала.');
  if(payload.publicationId && !result.collected) throw new Error('Видео больше недоступно для проверки.');
  report.log(`Обновлено видео: ${result.collected}`);
  return result;
}
