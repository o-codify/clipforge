import {createContext} from '../dist/context.js';
import {writeFile} from 'node:fs/promises';
const ctx=createContext();
try {
  const clips=await ctx.db.sql`select c.id,c.run_id as "runId",c.streamer,c.start,c.end,c.duration,
    c.file,r.out_dir as "outDir",r.settings->'sourceWindow' as "sourceWindow",
    r.settings->'renderedClips'->c.id as verification from clips c join runs r on r.id=c.run_id
    where c.archived_at is null order by c.created_at`;
  await writeFile('data/reviews/active-clips.json',JSON.stringify(clips,null,2));
  const [status]=await ctx.db.sql`select
    (select count(*)::int from clips where archived_at is null) active,
    (select count(*)::int from clips where archived_at is not null) archived,
    (select count(*)::int from jobs.job where name like 'heavy.%' and state in ('created','active','retry')) pending_heavy,
    (select value->>'developmentMode' from platform_runtime where key='settings') development_mode,
    (select value->>'state' from platform_runtime where key='worker') worker`;
  console.log(status);
  console.log(clips.map(c=>({channel:c.streamer,run:c.runId,start:c.start,end:c.end,
    camera:c.verification?.camera,
    minimap:c.verification?.minimap && {found:c.verification.minimap.found,rect:c.verification.minimap.rect,
      hits:c.verification.minimap.hits,samples:c.verification.minimap.samples},game:c.verification?.grid.game})));
}finally{await ctx.close();}
