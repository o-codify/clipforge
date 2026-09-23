import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { platformAccounts, publications, publicationMetrics } from "./schema.js";

// Leave room for five-day backups and the daily backup cleanup cycle.
export const YOUTUBE_DATA_RETENTION_DAYS = 21;
export const YOUTUBE_REVOCATION_RETRY_HOURS = 12;

/** Stop access and remove display data immediately, even if Google's revoke endpoint is down. */
export async function beginYoutubeDisconnect(db: Database, id: string) {
  const [account] = await db.update(platformAccounts).set({
    disconnectRequestedAt: sql`coalesce(${platformAccounts.disconnectRequestedAt},now())`, label: "",
  }).where(and(eq(platformAccounts.id,id),eq(platformAccounts.platform,"youtube"))).returning();
  if (!account) return;
  const rows=await db.select({id:publications.id}).from(publications)
    .where(and(eq(publications.platform,"youtube"),eq(publications.account,account.externalId)));
  await clearYoutubePublications(db,rows.map(row=>row.id));
  await db.execute(sql`delete from platform_runtime where key in ('youtube-access','metrics')`);
  return account;
}

/** Keeps only our own delivery tombstone, so automatic publishing cannot duplicate a removed upload. */
export async function clearYoutubePublications(db: Database, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const selected=sql.join(ids.map(id=>sql`${id}`),sql`, `);
  await db.transaction(async tx => {
    await tx.delete(publicationMetrics).where(inArray(publicationMetrics.publicationId,ids));
    await tx.update(publications).set({account:sql`'removed:' || ${publications.id}`,status:"takedown",
      operationId:null,mediaId:null,url:null,title:null,caption:null,privacy:null,publishedAt:null,error:null,updatedAt:new Date(),
    }).where(and(eq(publications.platform,"youtube"),inArray(publications.id,ids)));
    // Publication logs may contain provider video IDs/URLs. Queue payloads only contain our own ID.
    await tx.execute(sql`delete from job_events where job_id in
      (select id from jobs.job where name='light.publish-clip' and data->>'publicationId' in (${selected}))`);
    await tx.execute(sql`update jobs.job set output=null where name='light.publish-clip' and data->>'publicationId' in (${selected})`);
  });
}

/** Idempotent cleanup after confirmed revocation or expired authorization. No YouTube videos are deleted. */
export async function forgetYoutubeAccount(db: Database, id: string): Promise<void> {
  const account = await beginYoutubeDisconnect(db,id);
  if(!account) return;
  await db.transaction(async tx=>{
    await tx.delete(platformAccounts).where(eq(platformAccounts.id,id));
    await tx.execute(sql`delete from platform_runtime where key in ('youtube-access','metrics')`);
  });
}

/** Live data expires before backups, so their combined retention stays below 30 days. */
export async function pruneYoutubeData(db: Database): Promise<void> {
  await db.delete(publicationMetrics).where(sql`${publicationMetrics.collectedAt} < now() - ${YOUTUBE_DATA_RETENTION_DAYS} * interval '1 day'`);
  const stale=await db.select({id:publications.id}).from(publications).where(and(eq(publications.platform,"youtube"),
    sql`${publications.mediaId} is not null`,sql`${publications.updatedAt} < now() - ${YOUTUBE_DATA_RETENTION_DAYS} * interval '1 day'`));
  await clearYoutubePublications(db,stale.map(row=>row.id));
}

/** Run on an offline restored database before starting the application or any worker. */
export async function sanitizeRestoredYoutubeData(db: Database): Promise<void> {
  const rows=await db.select({id:publications.id}).from(publications).where(eq(publications.platform,"youtube"));
  await clearYoutubePublications(db,rows.map(row=>row.id));
  await db.transaction(async tx=>{
    await tx.delete(platformAccounts).where(eq(platformAccounts.platform,"youtube"));
    await tx.execute(sql`delete from platform_runtime where key in ('youtube-access','metrics','youtube-policy')`);
    await tx.execute(sql`insert into platform_runtime(key,value) values('settings','{"paused":true,"developmentMode":true}'::jsonb)
      on conflict(key) do update set value=platform_runtime.value || excluded.value,updated_at=now()`);
  });
}

/** Enabled only after a recorded YouTube approval; ordinary views/counts do not need this allowance. */
export async function youtubeDerivedMetricsAllowed(db: Database): Promise<boolean> {
  const [row]=await db.execute<{allowed:boolean}>(sql`select value->>'derivedMetricsApproved'='true' as allowed from platform_runtime where key='youtube-policy'`);
  return row?.allowed===true;
}
