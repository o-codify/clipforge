import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runMediaCommand, type Workspace} from '@clipforge/pipeline';

/** An interrupted native HLS download contains complete, consecutive fragments.
 * Keep it resumable: materialize a separate, bounded source, never promote .part
 * to the full VOD or touch the full transcript/audio/signals. */
export async function cachedPreview(workspace:Workspace, format:string, seconds=1800) {
  if(!Number.isFinite(seconds)||seconds<=0)throw new Error('Invalid preview duration');
  const full=workspace.video(format);
  if(await stat(full).then(s=>s.size>0).catch(()=>false))return null;
  const pending=full.replace(/\.mp4$/,'.pending.mp4');
  const partial=`${pending}.part`;
  const directory=join(workspace.root,`preview-prefix-${seconds}`);
  const video=join(directory,'video.mp4');
  const audio=join(directory,'audio.m4a');
  const manifest=join(directory,'source.json');
  const usable=async(path:string,duration:number)=>{
    try {
      const p=await runMediaCommand('ffprobe',['-v','error','-show_entries','format=duration',
        '-of','json',path],30_000);
      return p.code===0&&Number(JSON.parse(p.stdout).format?.duration)>=duration-.1;
    }catch{return false;}
  };
  const saved=await readFile(manifest,'utf8').then(JSON.parse).catch(()=>null);
  if(saved?.version===1&&saved?.seconds===seconds&&saved?.partial===partial
    &&await usable(video,seconds+4)&&await usable(audio,seconds))return {directory,video,audio,seconds};
  const checkpoint=await readFile(`${pending}.ytdl`,'utf8').then(JSON.parse).catch(()=>null);
  if(!(checkpoint?.downloader?.current_fragment?.index>0)||!await usable(partial,seconds+5))return null;
  await mkdir(directory,{recursive:true});
  const run=async(args:string[])=>{
    const result=await runMediaCommand('ffmpeg',['-v','error','-y','-threads','2',...args],600_000,256);
    if(result.code!==0)throw new Error(`Не удалось подготовить фрагмент: ${result.stderr.slice(-1500)}`);
  };
  // FFmpeg rebases Twitch's nonzero MPEG-TS PTS. Derive audio from this very
  // remux, so speech timestamps and picture remain on the same clock.
  const stagedVideo=join(directory,'video.pending.mp4');
  await run(['-i',partial,'-t',String(seconds+4),'-map','0:v:0','-map','0:a:0',
    '-c','copy','-avoid_negative_ts','make_zero','-movflags','+faststart',stagedVideo]);
  if(!await usable(stagedVideo,seconds+4))throw new Error('Сохранённый фрагмент видео неполон');
  await rename(stagedVideo,video);
  const stagedAudio=join(directory,'audio.pending.m4a');
  await run(['-i',video,'-t',String(seconds),'-vn','-c:a','aac','-threads','2',stagedAudio]);
  if(!await usable(stagedAudio,seconds))throw new Error('Сохранённый фрагмент звука неполон');
  await rename(stagedAudio,audio);
  await writeFile(manifest,JSON.stringify({version:1,partial,seconds,offsetSeconds:0}));
  return {directory,video,audio,seconds};
}
