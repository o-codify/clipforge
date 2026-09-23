import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { platformAccounts, publications, publicationMetrics } from "./schema.js";

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
  // Serialize against an API enqueue, then leave a durable disconnect marker for all readers.
  const account = await db.transaction(async tx => {
    const [row] = await tx.select().from(platformAccounts).where(and(eq(platformAccounts.id,id),eq(platformAccounts.platform,"youtube"))).for("update");
    if(row) await tx.update(platformAccounts).set({disconnectRequestedAt:row.disconnectRequestedAt??new Date()}).where(eq(platformAccounts.id,id));
    return row;
  });
  if(!account) return;
  const rows=await db.select({id:publications.id}).from(publications).where(and(eq(publications.platform,"youtube"),eq(publications.account,account.externalId)));
  await clearYoutubePublications(db,rows.map(row=>row.id));
  await db.delete(platformAccounts).where(eq(platformAccounts.id,id));
  await db.execute(sql`delete from platform_runtime where key in ('youtube-access','metrics')`);
}

/** Refresh/delete window is shorter than 30 days, including when Google is unavailable. */
export async function pruneYoutubeData(db: Database): Promise<void> {
  await db.delete(publicationMetrics).where(sql`${publicationMetrics.collectedAt} < now() - interval '29 days'`);
  const stale=await db.select({id:publications.id}).from(publications).where(and(eq(publications.platform,"youtube"),
    sql`${publications.mediaId} is not null`,sql`${publications.updatedAt} < now() - interval '29 days'`));
  await clearYoutubePublications(db,stale.map(row=>row.id));
}

/** Enabled only after a recorded YouTube approval; ordinary views/counts do not need this allowance. */
export async function youtubeDerivedMetricsAllowed(db: Database): Promise<boolean> {
  const [row]=await db.execute<{allowed:boolean}>(sql`select value->>'derivedMetricsApproved'='true' as allowed from platform_runtime where key='youtube-policy'`);
  return row?.allowed===true;
}
