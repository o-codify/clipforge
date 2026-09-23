import {createContext} from '../dist/context.js';
import {upgradeRuntime} from '../../../packages/db/dist/index.js';
import {writeFile, mkdir} from 'node:fs/promises';
const ctx=createContext();
try {
  await upgradeRuntime(ctx.db);
  const rows=await ctx.db.sql`select c.id,c.run_id,c.streamer,c.version,c.state,c.file,r.out_dir,
    (select count(*) from publications p where p.clip_id=c.id)::int as publications
    from clips c join runs r on r.id=c.run_id where c.archived_at is null
    and c.created_at < ${new Date(1790171657643)} order by c.created_at`;
  console.log({clips:rows.length,channels:[...new Set(rows.map(c=>c.streamer))],publicationReferences:rows.reduce((n,c)=>n+c.publications,0)});
  if(process.argv.includes('--apply')) {
    await mkdir('data/reviews/archive',{recursive:true});
    const manifest=`data/reviews/archive/obsolete-${Date.now()}.json`;
    await writeFile(manifest,JSON.stringify(rows,null,2));
    const ids=rows.map(c=>c.id);
    if(ids.length) await ctx.db.sql`update clips set archived_at=now(),archive_reason='Устаревшие пробы до исправления камеры и горизонтального кадра' where id=any(${ids})`;
    console.log({archived:rows.length,manifest});
  }
}finally{await ctx.close();}
