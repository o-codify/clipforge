import { access } from "node:fs/promises";
import type { Context } from "./context.js";
import { runMediaCommand } from '@clipforge/pipeline';

export async function storeClip(ctx: Context, id: string, file: string) {
  if(ctx.remote)return ctx.remote.uploadClip(id,file);
  if (!ctx.storage) return null;
  const poster = `${file}.jpg`;
  const generated = await runMediaCommand('ffmpeg',['-v','error','-y','-ss','2.5','-i',file,'-frames:v','1','-vf','scale=270:-2',poster],60000);
  if (generated.code !== 0) throw new Error('Poster generation failed');
  await access(poster);
  const videoKey = ctx.storage.key(id, "video.mp4");
  const posterKey = ctx.storage.key(id, "poster.jpg");
  await ctx.storage.uploadFile(videoKey, file, "video/mp4");
  await ctx.storage.uploadFile(posterKey, poster, "image/jpeg");
  return { videoKey, posterKey };
}
