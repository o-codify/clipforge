import {and,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {vods,runs,clips,runtimeValue,withVodLock,enqueueUnique} from '@clipforge/db';
import {type PayloadOf,QUEUES} from '@clipforge/jobs';
import type {Context} from './context.js';
import {runPipeline,type JobReport} from './handlers.js';
import {preparePreview} from './prepare-preview.js';

type Plan={vodIds:string[];requested:Record<string,number>;finished:string[];errors:Record<string,string>;children?:Record<string,string>};

/** Durable, draft-only daily batch. No publication intent is created here. */
export async function prepareStreamer(ctx:Context,input:PayloadOf<typeof QUEUES.prepareStreamer>,report:JobReport, pipeline:typeof runPipeline=preparePreview) {
  if(!report.id)throw new Error('Подборке нужен идентификатор задания');
  const key=`draft-batch:${report.id}`;
  const [saved]=await ctx.db.execute<{value:Plan}>(sql`select value from platform_runtime where key=${key}`);
  const available=await ctx.db.select().from(vods).where(and(eq(vods.streamer,input.login),input.vodIds?inArray(vods.id,input.vodIds):undefined)).orderBy(desc(vods.publishedAt)).limit(40);
  const ids=input.vodIds??available.filter(v=>(v.duration??0)>300).sort((a,b)=>Number(!!b.fetchedAt)-Number(!!a.fetchedAt)).slice(0,20).map(v=>v.id);
  if(ids.some(id=>!available.some(v=>v.id===id)))throw new Error('Все эфиры подборки должны принадлежать выбранному стримеру');
  const plan:Plan=saved?.value??{vodIds:ids,requested:{},finished:[],errors:{}};
  const results=async()=>ctx.db.select({id:clips.id,vodId:clips.vodId}).from(clips).innerJoin(runs,eq(runs.id,clips.runId))
    .where(and(eq(runs.streamer,input.login),isNull(clips.archivedAt),sql`${clips.state}<>'blocked'`,sql`${runs.settings}->>'jobId'=${report.id}`));
  const save=async()=>{const list=await results();await runtimeValue(ctx.db,key,{...plan,target:input.count,ready:list.length,clipIds:list.map(c=>c.id),publication:'hold-for-user-review'});return list;};
  await save();
  if(process.env.WORKER_FLEET==='true'&&ctx.queue){
    // The parent coordinates only; independent VODs run on any free media worker.
    plan.children??={};
    const unfinished=plan.vodIds.filter(id=>!plan.finished.includes(id)&&!plan.errors[id]);
    const existing=await results();let remaining=Math.max(0,input.count-existing.length);
    await ctx.queue.createQueue(QUEUES.prepareBatchVod);
    for(let i=0;i<unfinished.length;i++){
      const vodId=unfinished[i]!;
      plan.requested[vodId]??=Math.min(100,Math.ceil(remaining/(unfinished.length-i)));
      remaining=Math.max(0,remaining-plan.requested[vodId]!);
      if(plan.children[vodId]||!plan.requested[vodId])continue;
      const singleton=`batch-vod:${report.id}:${vodId}`;
      const data={batchId:report.id,vodId,count:plan.requested[vodId],audioMode:input.audioMode,reuse:true,testBatch:true,skipExisting:true};
      const id=await enqueueUnique(ctx.db,QUEUES.prepareBatchVod,singleton,()=>ctx.queue!.send(QUEUES.prepareBatchVod,data,
        {singletonKey:singleton,retryLimit:3,retryDelay:60,retryBackoff:true,expireInSeconds:6*3600}));
      const [previous]=id?[]:await ctx.db.execute<{id:string}>(sql`select id::text from jobs.job where name=${QUEUES.prepareBatchVod} and singleton_key=${singleton} order by created_on desc limit 1`);
      if(id||previous)plan.children[vodId]=id??previous!.id;
      await save();
    }
    while(true){
      if(await report.cancelled()){for(const id of Object.values(plan.children))await ctx.queue.cancel(QUEUES.prepareBatchVod,id);return {cancelled:true};}
      const children=Object.entries(plan.children);if(!children.length)break;
      const jobs=await ctx.db.execute<{id:string;state:string}>(sql`select id::text,state from jobs.job where id in (${sql.join(children.map(([,id])=>sql`${id}::uuid`),sql`,`)})`);
      for(const [vod,id] of children)if(jobs.some(j=>j.id===id&&j.state==='completed')&&!plan.finished.includes(vod))plan.finished.push(vod);
      const ready=await save();report.log(`Подборка: ${ready.length}/${input.count}. Эфиров завершено: ${plan.finished.length}/${plan.vodIds.length}.`);
      if(jobs.some(j=>['failed','expired','cancelled'].includes(j.state)))throw new Error('Один из воркеров не завершил эфир; готовые клипы сохранены');
      if(jobs.length!==children.length)throw new Error('Дочернее задание подборки недоступно');
      if(jobs.every(j=>j.state==='completed'))break;
      await new Promise(resolve=>setTimeout(resolve,10000));
    }
    const ready=await save();
    if(ready.length<input.count)throw new Error(`Подборка: ${ready.length}/${input.count}. В выбранных эфирах недостаточно новых моментов.`);
    return {requested:input.count,rendered:ready.length,clipIds:ready.map(c=>c.id)};
  }
  for(const vodId of plan.vodIds) {
    if(await report.cancelled())return {cancelled:true,rendered:(await save()).length};
    const existing=await results();
    if(existing.length>=input.count)break;
    if(plan.finished.includes(vodId)||plan.errors[vodId])continue;
    // Prefer multiple broadcasts: no one VOD fills the entire daily batch.
    const lastSource=vodId===plan.vodIds.at(-1);
    plan.requested[vodId]??=Math.min(lastSource?input.count:40,input.count-existing.length);
    await save();
    report.log(`Подборка: ${existing.length}/${input.count}. Эфир ${vodId}.`);
    try {
      await withVodLock(ctx.db,vodId,()=>pipeline(ctx,{vodId,count:plan.requested[vodId],reuse:true,
        skipExisting:true,testBatch:true,...(input.audioMode?{audioMode:input.audioMode}:{})},report));
      if(await report.cancelled())return {cancelled:true};
      plan.finished.push(vodId);
    } catch(error) {
      if(await report.cancelled())return {cancelled:true};
      // Infrastructure/resource failures are retried with the same run and its
      // checkpoints; only unavailable/exhausted sources are skipped permanently.
      const message=String(error);
      if(!/not available|does not exist|not found|404|Нет новых моментов|No video formats|не найд|удалён/i.test(message))throw error;
      plan.errors[vodId]=message.slice(0,500);
      report.log(`Эфир ${vodId} пропущен: ${message.slice(0,200)}`);
    }
    await save();
  }
  const ready=await save();
  if(ready.length<input.count)throw new Error(`Подборка: ${ready.length}/${input.count}. Доступных подходящих моментов не хватило; готовые черновики сохранены.`);
  return {requested:input.count,rendered:ready.length,clipIds:ready.map(c=>c.id),publication:'hold-for-user-review'};
}

export async function prepareBatchVod(ctx:Context,payload:PayloadOf<typeof QUEUES.prepareBatchVod>,report:JobReport){
  return preparePreview(ctx,payload,{...report,id:payload.batchId,cancelled:async()=>{
    if(await report.cancelled())return true;
    const [parent]=await ctx.db.execute<{state:string}>(sql`select state from jobs.job where id=${payload.batchId}::uuid`);
    return !parent||parent.state==='cancelled';
  }});
}
