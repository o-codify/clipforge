import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { streamers, vods } from "./schema.js";

export type AudioMode = "original" | "dtln" | "dtln-gated";

/** Read at render start, so one run has a stable setting across all its clips. */
export async function vodAudioSettings(db: Database, vodId: string, runMode?: AudioMode) {
  const [row] = await db.select({ override: vods.audioMode, streamerMode: streamers.audioMode })
    .from(vods).innerJoin(streamers, eq(streamers.login, vods.streamer)).where(eq(vods.id, vodId));
  if (!row) throw new Error(`Нет эфира ${vodId}`);
  return { ...row, mode: runMode ?? row.override ?? row.streamerMode,
    source: runMode !== undefined ? "run" as const : row.override !== null ? "vod" as const : "streamer" as const };
}

/** A VOD override wins; null follows the current streamer default. */
export async function vodAdSettings(db: Database, vodId: string) {
  const [row] = await db.select({override:vods.adCheckEnabled,streamerEnabled:streamers.adCheckEnabled})
    .from(vods).innerJoin(streamers,eq(streamers.login,vods.streamer)).where(eq(vods.id,vodId));
  if(!row)throw new Error(`Нет эфира ${vodId}`);
  return {...row,enabled:row.override??row.streamerEnabled,source:row.override===null?'streamer':'vod'};
}
