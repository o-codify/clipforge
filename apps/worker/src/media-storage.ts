import { access } from "node:fs/promises";
import type { Context } from "./context.js";
import { runMediaCommand } from '@clipforge/pipeline';
import {removeCachedFile} from './storage.js';

/** Call only after verified object upload AND catalog commit. */
export async function releaseClip(ctx:Context,file:string){
  if(!ctx.remote&&!ctx.storage)return;
  for(const path of [file,file+'.jpg',file+'.dtln.wav',file+'.ass'])await removeCachedFile(ctx.config.out,path);
}

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
