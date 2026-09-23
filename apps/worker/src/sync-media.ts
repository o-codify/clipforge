import { eq, isNull } from "drizzle-orm";
import { join } from "node:path";
import { clips, runs, upgradeRuntime } from "@clipforge/db";
import { createContext } from "./context.js";
import { storeClip } from "./media-storage.js";

const ctx = createContext();
try {
  if (!ctx.storage) throw new Error("S3 is not configured");
  await upgradeRuntime(ctx.db);
  const rows = await ctx.db.select({clip:clips,outDir:runs.outDir}).from(clips)
    .innerJoin(runs,eq(runs.id,clips.runId)).where(isNull(clips.archivedAt));
  for (const {clip,outDir} of rows) {
    if (clip.mediaStorage) continue;
    ctx.log(`S3: ${clip.id}, ${(Number(clip.sizeBytes)/1024**2).toFixed(1)} MB`);
    const mediaStorage = await storeClip(ctx,clip.id,join(outDir,clip.file));
    await ctx.db.update(clips).set({mediaStorage}).where(eq(clips.id,clip.id));
    ctx.log(`S3: ${clip.id} сохранён`);
  }
} finally { ctx.storage?.client.destroy(); await ctx.close(); }
