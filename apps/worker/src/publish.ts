/**
 * Публикация клипа на YouTube.
 *
 * Ряд publications уже создан бэкендом - обработчик только выполняет:
 * обновляет access token, использует согласованные название и описание,
 * заливает файл и следит за обработкой первые полторы минуты.
 *
 * Фактическая видимость проверяется после загрузки: YouTube может
 * ограничивать публикации непроверенного проекта приватным доступом.
 */
import { join } from "node:path";

import { and, eq, sql } from "drizzle-orm";

import {
  clips, games, platformAccounts, publications, runs, streamers, type Database,
} from "@clipforge/db";
import type { PayloadOf, QUEUES } from "@clipforge/jobs";
import { refreshAccessToken, uploadVideo, videoStatus, suggestVideoMetadata, prepareVideoMetadata, videoTags, validateVideoMetadata, UploadSessionExpiredError } from "@clipforge/youtube";

import type { Context } from "./context.js";
import type { JobReport } from "./handlers.js";

async function setStatus(
  db: Database,
  id: string,
  values: Partial<typeof publications.$inferInsert>,
): Promise<void> {
  // Revocation can turn this record into a tombstone during an in-flight upload.
  await db.update(publications).set({...values,updatedAt:new Date()}).where(and(eq(publications.id,id),sql`${publications.status} <> 'takedown'`));
}

export async function publishClip(
  ctx: Context,
  payload: PayloadOf<typeof QUEUES.publishClip>,
  report: JobReport,
): Promise<{ videoId?: string; message?: string }> {
  if (!ctx.youtube) throw new Error("не заданы YOUTUBE_CLIENT_ID и YOUTUBE_CLIENT_SECRET");

  const [row] = await ctx.db
    .select({
      publication: publications,
      file: clips.file,
      storage: clips.mediaStorage,
      outDir: runs.outDir,
      state: clips.state,
      archivedAt: clips.archivedAt,
      login: clips.streamer,
      displayName: streamers.displayName,
      gameTitle: games.title,
    })
    .from(publications)
    .innerJoin(clips, eq(clips.id, publications.clipId))
    .innerJoin(runs, eq(runs.id, clips.runId))
    .innerJoin(streamers, eq(streamers.login, clips.streamer))
    .leftJoin(games, eq(games.slug, clips.game))
    .where(eq(publications.id, payload.publicationId));

  if (!row) throw new Error(`публикация ${payload.publicationId} не найдена`);
  if(row.publication.status === "takedown")return {message:"Публикация отменена"};
  if (row.publication.mediaId) {
    return { message: "уже опубликован" };
  }
  const [savedSession]=await ctx.db.execute<{url:string;size:string}>(sql`select url,size from youtube_upload_sessions where publication_id=${row.publication.id}`);
  if ((!savedSession && row.publication.status === "uploading") || row.publication.error?.startsWith("[upload-uncertain]")) {
    throw new Error("Исход предыдущей загрузки неизвестен. Проверьте YouTube-канал перед повторной отправкой.");
  }
  if (row.state !== "ready" || row.archivedAt) {
    await setStatus(ctx.db, row.publication.id, {
      status: "failed",
      error: "клип снят с публикации",
    });
    throw new Error("клип снят с публикации");
  }

  const [account] = await ctx.db
    .select()
    .from(platformAccounts)
    .where(and(eq(platformAccounts.platform, "youtube"), eq(platformAccounts.externalId, row.publication.account)));
  const refreshToken = account?.credentials?.refreshToken;
  if (!refreshToken || account.disconnectRequestedAt) throw new Error("YouTube не подключён");

  const suggestion = suggestVideoMetadata({
    displayName: row.displayName ?? row.login,
    login: row.login,
    gameTitle: row.gameTitle,
  });
  const metadata = prepareVideoMetadata({
    title: row.publication.title ?? suggestion.title,
    description: row.publication.caption ?? suggestion.description,
    privacy: (row.publication.privacy ?? (process.env.YOUTUBE_PRIVACY === "public" ? "public" : process.env.YOUTUBE_PRIVACY === "unlisted" ? "unlisted" : "private")) as "private"|"unlisted"|"public",
  });
  validateVideoMetadata(metadata);
  const { title } = metadata;
  report.log(`«${title}» -> ${account.label}`);

  await setStatus(ctx.db, row.publication.id, {
    status: "uploading",
    title,
    caption: metadata.description,
    privacy: metadata.privacy,
    error: null,
  });

  try {
    const accessToken = await refreshAccessToken(ctx.youtube, refreshToken);
    const source = row.storage && ctx.storage ? await ctx.storage.openVideo(row.storage.videoKey) : undefined;
    if (ctx.config.role === 'control' && !source) throw new Error('Клип ещё не загружен в S3');
    const videoId = await uploadVideo(accessToken, {
      ...(source ? {source:{...source,reopen:(offset:number)=>ctx.storage!.openVideoRange(row.storage!.videoKey,offset)}} : {file:join(row.outDir, row.file)}),
      session:savedSession ? {url:savedSession.url,size:Number(savedSession.size)} : undefined,
      saveSession:async session=>{
        await ctx.db.execute(sql`insert into youtube_upload_sessions(publication_id,url,size) values(${row.publication.id},${session.url},${session.size})`);
      },
      ...metadata,
      tags: videoTags(row.login, row.gameTitle),
    });

    const url = `https://www.youtube.com/shorts/${videoId}`;
    await setStatus(ctx.db, row.publication.id, {
      status: "processing",
      operationId: videoId,
      mediaId: videoId,
      url,
    });
    await ctx.db.execute(sql`delete from youtube_upload_sessions where publication_id=${row.publication.id}`);
    report.log("Файл принят YouTube");

    // Обработка обычно занимает меньше минуты - подождать её здесь
    // дешевле, чем заводить отдельный опрос. Не успела - останется
    // «обрабатывается», ссылка уже рабочая.
    for (let attempt = 0; attempt < 18; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const status = await videoStatus(accessToken, videoId).catch(() => null);
      if (status?.uploadStatus === "processed") {
        await setStatus(ctx.db, row.publication.id, {
          privacy: status.privacyStatus,
          status: status.privacyStatus === "public" ? "published" : "uploaded",
          publishedAt: status.privacyStatus === "public" ? new Date() : null,
        });
        report.log("обработан");
        break;
      }
      if (status?.uploadStatus === "rejected" || status?.uploadStatus === "failed") {
        await setStatus(ctx.db, row.publication.id, {
          status: "failed",
          error: `площадка отклонила ролик: ${status.uploadStatus}`,
        });
        throw new Error(`площадка отклонила ролик: ${status.uploadStatus}`);
      }
    }

    return { message: "Проверка загрузки завершена" };
  } catch (error) {
    await setStatus(ctx.db, row.publication.id, {
      status: "failed",
      error: `${error instanceof UploadSessionExpiredError ? "[upload-uncertain] " : ""}${String(error)}`.slice(0, 500),
    });
    throw error;
  }
}
