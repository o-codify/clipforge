import type PgBoss from 'pg-boss';
import {setTimeout as delay} from 'node:timers/promises';

/** Pull only when a lane is free. boss.work per queue would reserve one heavy job
 * per queue, starving otherwise idle peers behind this process's local mutex. */
export function startConsumers(boss:Pick<PgBoss,'fetch'|'complete'|'fail'>,queues:string[],
  execute:(queue:string,job:PgBoss.Job)=>Promise<unknown>,ready:(heavy:boolean,queue?:string)=>Promise<boolean>,log:(message:string)=>void){
  let stopping=false;const active=new Set<Promise<void>>();
  const coordinator=(q:string)=>q==='heavy.prepare-streamer';
  const loop=async(lane:'heavy'|'light'|'coordinator')=>{
    const heavy=lane==='heavy';
    const names=queues.filter(q=>coordinator(q)?lane==='coordinator':lane!=='coordinator'&&q.startsWith('heavy.')===heavy);let cursor=0;
    while(!stopping&&names.length){
      let found=false;
      try{
        if(await ready(heavy))for(let i=0;i<names.length&&!stopping;i++){
          const name=names[cursor++%names.length]!;
          if(!await ready(heavy,name))continue;
          const [job]=await boss.fetch<object>(name,{batchSize:1});if(!job)continue;
          found=true;
          try{const output=await execute(name,job);await boss.complete(name,job.id,(output??{}) as object);}
          catch(error){await boss.fail(name,job.id,{message:String(error).slice(0,2000)});}
          break;
        }
      }catch(error){log(`Очередь: ${String(error)}`);}
      if(!found)await delay(1500);
    }
  };
  for(const lane of ['heavy','light','light','coordinator'] as const){const task=loop(lane);active.add(task);void task.finally(()=>active.delete(task));}
  return async()=>{stopping=true;await Promise.allSettled(active);};
}
