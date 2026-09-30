import {and,eq} from 'drizzle-orm';
import {vods} from '@clipforge/db';
import {Workspace,readSignals,speechHeadroomMb} from '@clipforge/pipeline';
import {resourceState} from '@clipforge/resources';
import {join} from 'node:path';
import {cachedPreview} from './cached-preview.js';
import {renderRun,runPipeline,type JobReport} from './handlers.js';
import type {Context} from './context.js';

/** Draft-only preparation may reuse a complete prefix of an interrupted VOD. */
export async function preparePreview(ctx:Context,payload:Parameters<typeof runPipeline>[1],report:JobReport) {
  const [row]=await ctx.db.select().from(vods).where(eq(vods.id,payload.vodId));
  if(!row)throw new Error('Эфир не найден');
  const draft={...payload,testBatch:true,skipExisting:true,reuse:true};
  const workspace=new Workspace({data:ctx.config.data,out:ctx.config.out},
    {game:row.game??'unknown',streamer:row.streamer,vodId:row.id});
  const source=await cachedPreview(workspace,ctx.config.videoFormat);
  if(!source)return runPipeline(ctx,draft,report);
  await ctx.db.update(vods).set({state:'known',error:null})
    .where(and(eq(vods.id,row.id),eq(vods.state,'fetching')));
  const cancelled=async()=>{if(await report.cancelled())throw new Error('Подготовка черновиков отменена');};
  await cancelled();
  report.log(`Отбор из сохранённых ${source.seconds/60} минут эфира. Полная запись остаётся нескачанной.`);
  const resources=resourceState();
  if(process.env.MEDIA_RESOURCE_STATE&&(resources.paused
    ||(resources.memoryMb??0)-(resources.metrics?.ownMemoryMb??0)<speechHeadroomMb(ctx.config.speechModel))) {
    report.log('Ожидаю свободных ресурсов для распознавания речи; сохранённый фрагмент готов.');
  }
  const result=await ctx.python.call('transcribe',{
    audio:source.audio,model:ctx.config.speechModel,language:ctx.config.speechLanguage,
    batchSize:ctx.config.speechBatchSize,glossary:ctx.config.glossary,
  },{cancelled:report.cancelled,onEvent:e=>report.log(e.event==='log'?e.message:`${e.stage}${e.value===null?'':` ${Math.round(e.value*100)}%`}`)});
  await cancelled();
  const signals=await ctx.python.call('audioSignals',{audio:source.audio,out:join(source.directory,'signals.f32')});
  await cancelled();
  return renderRun(ctx,draft,report,{
    video:source.video,offsetSeconds:0,transcript:{...result,model:ctx.config.speechModel},
    signals:await readSignals(signals.file,signals),
  });
}
