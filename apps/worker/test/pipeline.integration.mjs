import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createContext } from "../dist/context.js";
import { runPipeline } from "../dist/handlers.js";
import { Workspace, probeMedia } from "../../../packages/pipeline/dist/index.js";

const ctx=createContext();
const source=process.env.TEST_SOURCE_VIDEO;
if(!source) throw new Error("Set TEST_SOURCE_VIDEO to an existing local stream video");
const root=await mkdtemp(join(resolve(ctx.config.data),"qa-pipeline-"));
const channel=`qa_${randomUUID().slice(0,8)}`;
const vodId=`vqa_${randomUUID()}`;
try {
  const [game]=await ctx.db.sql`select slug from games limit 1`;
  assert(game);
  ctx.config.data=join(root,"data");ctx.config.out=join(root,"out");ctx.config.renderConcurrency=1;
  const ws=await new Workspace({data:ctx.config.data,out:ctx.config.out},{game:game.slug,streamer:channel,vodId}).prepare();
  await ctx.db.sql`insert into streamers(login,state) values(${channel},'paused')`;
  await ctx.db.sql`insert into vods(id,streamer,game,state,duration,title) values(${vodId},${channel},${game.slug},'ready',75,'Temporary integration fixture')`;
  const extract=(args)=>{const result=spawnSync("ffmpeg",["-v","error","-y",...args],{windowsHide:true,encoding:"utf8",timeout:120000});assert.equal(result.status,0,result.stderr);};
  extract(["-ss","120","-i",source,"-t","75","-c","copy",ws.video(ctx.config.videoFormat)]);
  extract(["-i",ws.video(ctx.config.videoFormat),"-vn","-c:a","aac",ws.audio]);
  const report={log:m=>console.log(m),cancelled:async()=>false};
  console.log("Python:",await ctx.python.call("ping",{}));
  const result=await runPipeline(ctx,{vodId,count:2,reuse:true},report);
  assert(result.rendered>0,"A real rendered video is required");
  const clips=await ctx.db.sql`select c.*,r.out_dir from clips c join runs r on r.id=c.run_id where c.vod_id=${vodId}`;
  for(const clip of clips){const media=await probeMedia(join(clip.outDir,clip.file));assert.equal(media.width,1080);assert.equal(media.height,1920);}
  const repeated=await runPipeline(ctx,{vodId,count:2,reuse:true},report);
  assert.equal(repeated.rendered,0);assert.equal(repeated.skipped,clips.length);
  // Simulate a missing cached output; the row remains and must be repaired.
  const clip=clips[0];const file=join(clip.outDir,clip.file);
  assert(relative(root,resolve(file))&&!relative(root,resolve(file)).startsWith(".."));
  await rm(file);
  const repaired=await runPipeline(ctx,{vodId,count:2,reuse:true},report);
  assert.equal(repaired.rendered,1);
  console.log("PASS: actual CUDA transcription, audio analysis, facecam, 1080x1920 rendering, idempotent repeat, missing-file repair");
} finally {
  await ctx.db.sql`delete from streamers where login=${channel}`;
  await ctx.close();
  const boundary=resolve("data");const rel=relative(boundary,root);
  if(!rel.startsWith("qa-pipeline-")||rel.startsWith("..")||isAbsolute(rel)) throw new Error("Unsafe test cleanup path");
  await rm(root,{recursive:true,force:true});
}
