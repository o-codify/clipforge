import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { platformAccounts, publications, publicationMetrics, runtimeValue, forgetYoutubeAccount, clearYoutubePublications, pruneYoutubeData } from "@clipforge/db";
import { refreshAccessToken, videoSnapshots, myChannel, revokeToken, YoutubeAccessRevokedError } from "@clipforge/youtube";
import type { Context } from "./context.js";

/** Reconciles actual visibility and authorization, including channels with no uploads. */
export async function collectMetrics(ctx: Context): Promise<void> {
  await pruneYoutubeData(ctx.db);
  const accounts=await ctx.db.select().from(platformAccounts).where(eq(platformAccounts.platform,"youtube"));
  let collected=0,failed=0;
  for(const account of accounts){
    if(account.disconnectRequestedAt){
      try{
        if(account.credentials.refreshToken)await revokeToken(account.credentials.refreshToken);
        await forgetYoutubeAccount(ctx.db,account.id);
      }catch{
        failed++;
        if(Date.now()-account.disconnectRequestedAt.getTime()>6*86400000)await forgetYoutubeAccount(ctx.db,account.id);
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
      const rows=await ctx.db.select().from(publications).where(and(eq(publications.platform,"youtube"),eq(publications.account,account.externalId),sql`${publications.mediaId} is not null`));
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
              publishedAt:processed&&isPublic?row.publishedAt??new Date():null,
              error:rejected?snapshot.status.rejectionReason??snapshot.status.uploadStatus:null,updatedAt:new Date(),
            }).where(and(eq(publications.id,row.id),eq(publications.account,account.externalId),eq(publications.mediaId,snapshot.id))).returning({id:publications.id});
            if(!changed.length)return;
            await tx.insert(publicationMetrics).values({id:randomUUID(),publicationId:row.id,
              views:Number(snapshot.statistics?.viewCount??0),likes:Number(snapshot.statistics?.likeCount??0),comments:Number(snapshot.statistics?.commentCount??0),
              extended:{privacy:snapshot.status.privacyStatus},raw:{}});
            collected++;
          });
        }
      }
    }catch(error){
      failed++;
      if(error instanceof YoutubeAccessRevokedError || Date.now()-(account.verifiedAt??account.createdAt).getTime()>29*86400000){
        await forgetYoutubeAccount(ctx.db,account.id);
      }
    }
  }
  await runtimeValue(ctx.db,"metrics",{state:failed?"error":"ok",collected,failed});
}
