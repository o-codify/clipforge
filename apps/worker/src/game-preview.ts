import {mkdir,readFile,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {Workspace,runMediaCommand} from '@clipforge/pipeline';
import type {Context} from './context.js';
import type {JobReport} from './handlers.js';
import type {VodData} from './media-task-data.js';
import {selectedGameWindow,gameSlug} from './game-selection.js';

/** Separate cache: a selected chapter is never promoted to a complete VOD. */
export async function gamePreview(ctx:Context,row:VodData,game:string,report:JobReport,range?:{start:number;end:number}) {
  const chapter=selectedGameWindow(row.chapters,game,range);
  const {start,end}=chapter;
  const ws=new Workspace({data:ctx.config.data,out:ctx.config.out},{game:row.game??'unknown',streamer:row.streamer,vodId:row.id});
  const directory=join(ws.root,`game-${gameSlug(game)}-${start}-${end}`);
  await ctx.remote?.restoreSources?.(ws.root,name=>name.startsWith(`game-${gameSlug(game)}-${start}-${end}/`)&&!name.endsWith('/source.ts'));
  await mkdir(directory,{recursive:true});
  const raw=join(directory,'source.ts'),video=join(directory,'video.mp4'),audio=join(directory,'audio.m4a');
  const ready=async(p:string)=>!!(await stat(p).catch(()=>null))?.size;
  const run=async(command:string,args:string[],timeout:number)=>{
    const result=await runMediaCommand(command,args,timeout,256);
    if(result.code!==0)throw new Error(`Не удалось подготовить главу игры: ${result.stderr.slice(-1200)}`);
  };
  report.log(`Подготовка ${chapter.title}: ${Math.round(start/60)}–${Math.round(end/60)} мин`);
  if((!await ready(raw)&&!await ready(video))||!await ready(join(directory,'source.json'))) {
    await run(ctx.config.pythonBin,[join(ctx.config.workerRoot,'clipforge_worker','download_window.py'),'--vod',row.id,
      '--output',raw,'--start',String(start),'--end',String(end),'--height',/\d+/.exec(ctx.config.videoFormat)?.[0]??'720',
      '--rate-kbps',String(ctx.config.mediaNetworkKbps)],7_200_000);
  }
  const source=JSON.parse(await readFile(join(directory,'source.json'),'utf8')) as {offsetSeconds:number;duration:number};
  if(!Number.isFinite(source.offsetSeconds)||!Number.isFinite(source.duration)||source.offsetSeconds>start||source.offsetSeconds+source.duration<end-.1)throw new Error('Неполный исходный фрагмент');
  if(!await ready(video)){
    const pending=join(directory,'video.pending.mp4');
    await run('ffmpeg',['-v','error','-y','-threads','2','-i',raw,'-map','0:v:0','-map','0:a:0','-c','copy','-avoid_negative_ts','make_zero','-movflags','+faststart',pending],600_000);
    await rename(pending,video);
  }
  if(!await ready(audio)){
    const pending=join(directory,'audio.pending.m4a');
    await run('ffmpeg',['-v','error','-y','-i',video,'-vn','-c:a','aac','-threads','2',pending],600_000);
    await rename(pending,audio);
  }
  return {directory,video,audio,seconds:source.duration,offsetSeconds:source.offsetSeconds};
}
