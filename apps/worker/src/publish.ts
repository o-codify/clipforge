/**
 * Публикация клипа на YouTube.
 *
 * Ряд publications уже создан бэкендом - обработчик только выполняет:
 * обновляет access token, собирает название и описание из данных клипа,
 * заливает файл и следит за обработкой первые полторы минуты.
 *
 * Ролик уходит непубличным (unlisted): автоматика не должна выпускать
 * контент в ленту без единого взгляда человека, пока канал молодой. К
 * тому же у не прошедшего аудит Google-проекта площадка сама запирает
 * загрузки в private - лучше честный unlisted по нашему выбору, чем
 * сюрприз от площадки.
 */
import { join } from "node:path";

import { and, eq } from "drizzle-orm";

import {
  clips, games, platformAccounts, publications, runs, streamers, type Database,
} from "@clipforge/db";
import type { PayloadOf, QUEUES } from "@clipforge/jobs";
import { refreshAccessToken, uploadVideo, videoStatus } from "@clipforge/youtube";

import type { Context } from "./context.js";
import type { JobReport } from "./handlers.js";

const TRIGGER_TITLES: Record<string, string> = {
  combat: "Жаркий момент",
  reaction: "Реакция",
  speech: "Разговор",
  loudness: "Громкий момент",
  misc: "Момент",
};

/** Название ролика: первые слова из клипа либо триггер. До 100 знаков. */
function buildTitle(row: {
  text: string | null;
  trigger: string | null;
  displayName: string;
  gameTitle: string | null;
}): string {
  const hook = (row.text ?? "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .split(" ")
    .reduce((acc, word) => (acc.length + word.length + 1 <= 55 ? `${acc} ${word}` : acc), "")
    .trim();
  const lead = hook || TRIGGER_TITLES[row.trigger ?? ""] || "Момент";
  const suffix = row.gameTitle ? ` | ${row.gameTitle}` : "";
  return `${lead} — ${row.displayName}${suffix} #shorts`;
}

function buildDescription(row: {
  displayName: string;
  login: string;
  gameTitle: string | null;
}): string {
  return [
    `Клип со стрима ${row.displayName}`,
    `Twitch: https://twitch.tv/${row.login}`,
    row.gameTitle ? `Игра: ${row.gameTitle}` : "",
    "",
    "#shorts #twitch",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

async function setStatus(
  db: Database,
  id: string,
  values: Partial<typeof publications.$inferInsert>,
): Promise<void> {
  await db.update(publications).set(values).where(eq(publications.id, id));
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
      outDir: runs.outDir,
      text: clips.text,
      trigger: clips.trigger,
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
  if (row.publication.mediaId) {
    return { message: "уже опубликован" };
  }
  if (row.publication.status === "uploading" || row.publication.error?.startsWith("[upload-uncertain]")) {
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
  if (!refreshToken) throw new Error("YouTube не подключён");

  const title = buildTitle({
    text: row.text,
    trigger: row.trigger,
    displayName: row.displayName ?? row.login,
    gameTitle: row.gameTitle,
  });
  report.log(`«${title}» -> ${account.label}`);

  await setStatus(ctx.db, row.publication.id, {
    status: "uploading",
    title,
    error: null,
  });

  let uploadMayExist = false;
  try {
    const accessToken = await refreshAccessToken(ctx.youtube, refreshToken);
    uploadMayExist = true;
    const videoId = await uploadVideo(accessToken, {
      file: join(row.outDir, row.file),
      title,
      description: buildDescription({
        displayName: row.displayName ?? row.login,
        login: row.login,
        gameTitle: row.gameTitle,
      }),
      tags: [row.login, row.gameTitle ?? "", "twitch", "shorts"].filter(Boolean),
      privacy: process.env.YOUTUBE_PRIVACY === "public" ? "public" : process.env.YOUTUBE_PRIVACY === "unlisted" ? "unlisted" : "private",
    });

    const url = `https://www.youtube.com/shorts/${videoId}`;
    await setStatus(ctx.db, row.publication.id, {
      status: "processing",
      operationId: videoId,
      mediaId: videoId,
      url,
    });
    uploadMayExist = false;
    report.log(`залит: ${url}`);

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

    return { videoId };
  } catch (error) {
    await setStatus(ctx.db, row.publication.id, {
      status: "failed",
      error: `${uploadMayExist ? "[upload-uncertain] Проверьте канал перед повторной отправкой. " : ""}${String(error)}`.slice(0, 500),
    });
    throw error;
  }
}
