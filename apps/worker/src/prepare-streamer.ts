import {and,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {vods,runs,clips,runtimeValue,withVodLock} from '@clipforge/db';
import type {PayloadOf,QUEUES} from '@clipforge/jobs';
import type {Context} from './context.js';
import {runPipeline,type JobReport} from './handlers.js';
import {preparePreview} from './prepare-preview.js';

type Plan={vodIds:string[];requested:Record<string,number>;finished:string[];errors:Record<string,string>};

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
