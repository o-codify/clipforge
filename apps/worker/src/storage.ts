import { realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, join } from "node:path";
import { sql } from "drizzle-orm";
import { runtimeValue, withVodLock } from "@clipforge/db";
import { Workspace } from "@clipforge/pipeline";
import { numberEnv } from "./context.js";
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

/** Only new, successfully processed VODs qualify. Existing legacy data is preserved. */
export async function pruneSources(ctx: Context): Promise<void> {
  const days=numberEnv(process.env,"SOURCE_RETENTION_DAYS",2,1,365);
  const rows=await ctx.db.execute<{id:string;game:string;streamer:string}>(sql`
    select v.id,v.game,v.streamer from vods v join pipeline_attempts a on a.vod_id=v.id
    where a.state='completed' and v.state='ready'
      and a.updated_at < now() - ${days} * interval '1 day'
      and exists(select 1 from clips c where c.vod_id=v.id and c.archived_at is null)
      and not exists(select 1 from jobs.job j where j.data->>'vodId'=v.id and j.state in ('created','active','retry'))
    limit 10`);
  let bytes=0;
  for(const row of rows) {
    await withVodLock(ctx.db,row.id,async()=>{
    const busy=await ctx.db.execute(sql`select id from jobs.job where data->>'vodId'=${row.id} and state in ('created','active','retry') limit 1`);
    if(busy.length) return;
    // Confirm rendered results exist before discarding reproducible source media.
    const clips=await ctx.db.execute<{file:string;outDir:string}>(sql`select c.file,r.out_dir as "outDir" from clips c join runs r on r.id=c.run_id where c.vod_id=${row.id}`);
    if (!(await Promise.all(clips.map(c=>stat(join(c.outDir,c.file)).then(s=>s.size>0).catch(()=>false)))).every(Boolean)) return;
    const workspace=new Workspace({data:ctx.config.data,out:ctx.config.out},{game:row.game??"unknown",streamer:row.streamer,vodId:row.id});
    bytes+=await removeCachedFile(resolve(ctx.config.data),workspace.audio);
    bytes+=await removeCachedFile(resolve(ctx.config.data),workspace.video(ctx.config.videoFormat));
    await ctx.db.execute(sql`update vods set state='known',fetched_at=null,error='Исходники очищены после обработки; клипы и расшифровка сохранены' where id=${row.id}`);
    });
  }
  await ctx.db.execute(sql`delete from job_events where created_at < now()-interval '14 days'`);
  await ctx.db.execute(sql`delete from sessions where expires_at < now()`);
  await runtimeValue(ctx.db,"storage",{state:"ok",freedMb:Math.round(bytes/1024**2),retentionDays:days});
}
