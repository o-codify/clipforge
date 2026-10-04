import {createHash} from 'node:crypto';
import {mkdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {probeMedia,runMediaCommand,newRunId,Workspace} from '@clipforge/pipeline';
import type {PayloadOf,QUEUES} from '@clipforge/jobs';
import type {Context} from './context.js';
import {fetchVod,type JobReport} from './handlers.js';
import type {ClipData,RunData} from './media-task-data.js';
import {releaseClip} from './media-storage.js';
async function audioDuration(file:string){
  const probe=await runMediaCommand('ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=duration','-of','json',file],30000);
  return Number(JSON.parse(probe.stdout).streams?.[0]?.duration)||0;
}

/** Restore the VOD mix without re-encoding the video or modifying the old clip.
 * Each output is saved before continuing, so the normal publisher can pace it. */
export async function restoreAudio(ctx:Context,payload:PayloadOf<typeof QUEUES.restoreAudio>,report:JobReport){
  if(!ctx.remote)throw new Error('Для восстановления звука нужен подключённый воркер');
  const {audio}=await fetchVod(ctx,{vodId:payload.vodId,audioOnly:true},report);
  const sourceDuration=await audioDuration(audio);if(!sourceDuration)throw new Error('Не удалось проверить исходную дорожку');
  const results:string[]=[];
  for(const sourceId of payload.clipIds){
    if(await report.cancelled())return {cancelled:true,clipIds:results};
    const {clip,run}=await ctx.remote.call<{clip:ClipData;run:RunData}>('clip.get',{id:sourceId});
    if(!clip||!run||clip.state==='blocked'||clip.archivedAt||clip.start===null||clip.end===null)throw new Error('Исходный клип недоступен');
    const version=createHash('sha256').update('original-audio-v1:'+sourceId).digest('hex').slice(0,12),id=sourceId+'_original_'+version;
    if((await ctx.remote.call<{clip:ClipData|null}>('clip.get',{id})).clip){results.push(id);continue;}
    const workspace=new Workspace({data:ctx.config.data,out:ctx.config.out},{game:clip.game??'unknown',streamer:clip.streamer,vodId:payload.vodId});
    const dir=join(workspace.outRoot,'original-audio',version);await mkdir(dir,{recursive:true});
    const source=join(dir,'source.mp4'),file=join(dir,'clip.mp4');await ctx.remote.downloadClip(sourceId,source);
    const duration=(await probeMedia(source))?.duration;
    if(!duration||clip.start+duration>sourceDuration+.05)throw new Error('Исходной звуковой дорожки недостаточно для всего клипа');
    report.log(`Восстанавливаю исходный звук: ${results.length+1} из ${payload.clipIds.length}`);
    const result=await runMediaCommand('ffmpeg',['-v','error','-y','-i',source,'-ss',String(clip.start),'-i',audio,
      '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart',file],120000);
    const output=await probeMedia(file);
    if(result.code!==0||!output||Math.abs(output.duration-duration)>.1||Math.abs(await audioDuration(file)-duration)>.1)throw new Error('Не удалось восстановить полную звуковую дорожку');
    await ctx.remote.uploadClip(id,file);
    await ctx.remote.call('original-audio.save',{sourceClipId:sourceId,id,version,runId:newRunId(new Date()),file:'clip.mp4',sizeBytes:(await stat(file)).size});
    await releaseClip(ctx,file);await releaseClip(ctx,source);
    results.push(id);
  }
  return {clips:results.length,clipIds:results,audioMode:'original'};
}
