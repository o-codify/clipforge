import { realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, join } from "node:path";
import { sql } from "drizzle-orm";
import { runtimeValue } from "@clipforge/db";
import {cleanLocalCache} from "@clipforge/storage";
import {cacheManifest,pruneCloudMedia} from "./media-retention.js";
import type { Context } from "./context.js";

/** Deletes only a regular generated file whose real path stays inside the cache. */
export async function removeCachedFile(root: string, file: string): Promise<number> {
  const path = await realpath(file).catch(()=>null);
  if (!path) return 0;
  const boundary = await realpath(root);
  const part = relative(boundary,path);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Файл вне рабочего каталога");
  const info=await stat(path);
  if (!info.isFile()) throw new Error("Очистка допускает только отдельные файлы");
  await unlink(path);
  return info.size;
}

/** Local media are disposable only after cloud/catalog verification. */
export async function pruneSources(ctx: Context): Promise<void> {
  if(!ctx.storage)return;
  const manifest=await cacheManifest(ctx.db,ctx.storage);
  const local=await cleanLocalCache(ctx.config.data,ctx.config.out,manifest,true);
  const cloud=await pruneCloudMedia(ctx.db,ctx.storage);
  await ctx.db.execute(sql`delete from job_events where created_at < now()-interval '14 days'`);
  await ctx.db.execute(sql`delete from sessions where expires_at < now()`);
  await runtimeValue(ctx.db,"storage",{state:"ok",freedMb:Math.round(local.bytes/1048576),cloudFreedMb:Math.round(cloud.bytes/1048576)});
}
