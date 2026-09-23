import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { platformAccounts, publications, publicationMetrics, runtimeValue } from "@clipforge/db";
import { refreshAccessToken, videoSnapshots } from "@clipforge/youtube";
import type { Context } from "./context.js";

/** Reconciles uploads after restarts and records actual visibility, not requested visibility. */
export async function collectMetrics(ctx: Context): Promise<void> {
  if (!ctx.youtube) return;
  const accounts = await ctx.db.select().from(platformAccounts).where(eq(platformAccounts.platform,"youtube"));
  let collected = 0;
  for (const account of accounts) {
    if (!account.credentials.refreshToken) continue;
    const rows = await ctx.db.select().from(publications).where(and(eq(publications.platform,"youtube"),eq(publications.account,account.externalId),sql`${publications.mediaId} is not null`));
    if (!rows.length) continue;
    const token = await refreshAccessToken(ctx.youtube,account.credentials.refreshToken);
    for (let i=0;i<rows.length;i+=50) {
      const batch = rows.slice(i,i+50);
      const snapshots = await videoSnapshots(token,batch.map(r=>r.mediaId!));
      for (const snapshot of snapshots) {
        const row = batch.find(r=>r.mediaId===snapshot.id)!;
        const processed = snapshot.status.uploadStatus === "processed";
        const failed = ["rejected","failed","deleted"].includes(snapshot.status.uploadStatus);
        const isPublic = snapshot.status.privacyStatus === "public";
        await ctx.db.update(publications).set({
          privacy:snapshot.status.privacyStatus,
          status:failed ? "failed" : processed ? isPublic ? "published" : "uploaded" : "processing",
          publishedAt:processed && isPublic ? row.publishedAt ?? new Date() : null,
          error:failed ? snapshot.status.rejectionReason ?? snapshot.status.uploadStatus : null,
        }).where(eq(publications.id,row.id));
        await ctx.db.insert(publicationMetrics).values({id:randomUUID(),publicationId:row.id,
          views:Number(snapshot.statistics?.viewCount??0),likes:Number(snapshot.statistics?.likeCount??0),comments:Number(snapshot.statistics?.commentCount??0),
          extended:{privacy:snapshot.status.privacyStatus},raw:snapshot as unknown as Record<string,unknown>});
        collected++;
      }
    }
  }
  await runtimeValue(ctx.db,"metrics",{state:"ok",collected});
}
