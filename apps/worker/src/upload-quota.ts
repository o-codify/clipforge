import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {Database} from '@clipforge/db';
import type {CloudQuota} from '@clipforge/youtube';

export async function uploadWait(db:Pick<Database,'execute'>,channel:string,now=Date.now()) {
  const blocks=await db.execute<{value:{until:string;reason:string}}>(sql`select value from platform_runtime
    where key in (${'youtube-upload-block:'+channel},'youtube-upload-block:project')`);
  const blocked=blocks.filter(b=>Date.parse(b.value.until)>now).sort((a,b)=>Date.parse(b.value.until)-Date.parse(a.value.until))[0];
  if(blocked)return {until:blocked.value.until,message:blocked.value.reason==='channel-limit'?'YouTube достиг лимита загрузок канала':'Исчерпана квота проекта YouTube'};
  const [stored]=await db.execute<{value:CloudQuota}>(sql`select value from platform_runtime where key='youtube-quota'`);
  const q=stored?.value;
  if(q?.state==='ok'&&q.remaining!==null&&Date.parse(q.resetAt)>now){
    // Monitoring arrives late. Reserve each local videos.insert after its watermark.
    const [local]=await db.execute<{n:number}>(sql`select count(*)::int n from platform_runtime where key like 'upload-attempt:%'
      and updated_at>=${q.usageThrough??q.start}::timestamptz`);
    if(q.remaining-(local?.n??0)<=0)return {until:q.resetAt,message:'Исчерпана квота проекта YouTube'};
  }
  return null;
}

/** Serialize admission across every worker/channel, before creating an upload session. */
export async function reserveUpload(db:Database,channel:string,publicationId:string){
  await db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(740026)`);
    const wait=await uploadWait(tx,channel);
    if(wait)throw new Error(`[quota-wait] ${wait.message}`);
    await tx.execute(sql`insert into platform_runtime(key,value) values(${'upload-attempt:'+randomUUID()},
      ${JSON.stringify({channel,publicationId})}::jsonb)`);
  });
}
