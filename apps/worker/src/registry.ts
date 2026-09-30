import {hostname,availableParallelism,totalmem,freemem} from 'node:os';
import {readFile} from 'node:fs/promises';
import {sql} from 'drizzle-orm';
import type {Database} from '@clipforge/db';
import type PgBoss from 'pg-boss';

export async function capacity(){
  let cpus=availableParallelism(),memory=totalmem(),used=memory-freemem();
  const read=async(path:string)=>(await readFile(path,'utf8').catch(()=>'' )).trim();
  // cgroup v2 is the authoritative allocation; os.totalmem() may report the host.
  const [v2quota,v2limit,v2current,v1quota,v1period,v1limit,v1current]=await Promise.all([
    read('/sys/fs/cgroup/cpu.max'),read('/sys/fs/cgroup/memory.max'),read('/sys/fs/cgroup/memory.current'),
    read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
    read('/sys/fs/cgroup/memory/memory.limit_in_bytes'),read('/sys/fs/cgroup/memory/memory.usage_in_bytes')]);
  const quota=v2quota||(Number(v1quota)>0?`${v1quota} ${v1period}`:''),limit=v2limit||v1limit,current=v2current||v1current;
  if(quota&&quota.split(' ')[0]!=='max'){const [q,p]=quota.split(' ').map(Number);if(q!>0&&p!>0)cpus=Math.min(cpus,q!/p!);}
  if(limit&&limit!=='max'&&Number(limit)>0){memory=Math.min(memory,Number(limit));used=Number(current)||used;}
  const stats=await read('/sys/fs/cgroup/memory.stat')||await read('/sys/fs/cgroup/memory/memory.stat');
  const reclaimable=Number(stats.match(/^(?:total_)?inactive_file\s+(\d+)$/m)?.[1]??0);
  if(current)used=Math.max(0,used-reclaimable);
  return {cpus,memoryMb:Math.round(memory/1048576),usedMb:Math.round(used/1048576)};
}

export class WorkerRegistry {
  readonly id=process.env.WORKER_ID||`${hostname()}-${process.env.WORKER_ROLE||'all'}`;
  readonly label=process.env.WORKER_NAME||hostname();
  draining=false;
  constructor(private readonly db:Database) {if(!/^[\w.:-]{1,128}$/.test(this.id))throw new Error('Некорректный WORKER_ID');}
  async register(role:string,queues:string[]){
    // A fixed cutover prevents legacy recovery from touching jobs fetched by
    // this generation in the brief interval before their owner is recorded.
    await this.db.execute(sql`insert into platform_runtime(key,value) values('worker-fleet-cutover',jsonb_build_object('at',now())) on conflict(key) do nothing`);
    await this.db.execute(sql`insert into worker_instances(id,label,host,role,queues,version)
      values(${this.id},${this.label},${hostname()},${role},${JSON.stringify(queues)}::jsonb,${process.env.RELEASE_SHA??'local'})
      on conflict(id) do update set label=excluded.label,host=excluded.host,role=excluded.role,queues=excluded.queues,version=excluded.version,state='online',started_at=now(),heartbeat_at=now()`);
  }
  async beat(resources:unknown){
    const [row]=await this.db.execute<{draining:boolean}>(sql`update worker_instances set heartbeat_at=now(),state='online',resources=${JSON.stringify(resources)}::jsonb where id=${this.id} returning draining`);
    this.draining=row?.draining??true;
    await this.db.execute(sql`update worker_jobs set heartbeat_at=now() where worker_id=${this.id} and finished_at is null`);
  }
  async claim(id:string){await this.db.execute(sql`insert into worker_jobs(job_id,worker_id) values(${id}::uuid,${this.id})
    on conflict(job_id) do update set worker_id=excluded.worker_id,started_at=now(),heartbeat_at=now(),finished_at=null,stage=null`);}
  async stage(id:string,message:string){await this.db.execute(sql`update worker_jobs set stage=${message.slice(0,500)} where job_id=${id}::uuid and worker_id=${this.id} and finished_at is null`);}
  async finish(id:string){await this.db.execute(sql`update worker_jobs set finished_at=now() where job_id=${id}::uuid and worker_id=${this.id}`);}
  async offline(){await this.db.execute(sql`update worker_instances set state='offline',heartbeat_at=now() where id=${this.id}`);}
}

/** A stale timestamp alone is insufficient: the owning process must have lost its session lease. */
export async function recoverWorkers(db:Database,boss:Pick<PgBoss,'fail'>){
  const legacyConnection=await db.sql.reserve();let legacyLock=false;
  try{
    // Old media processes held this lock exclusively. Shared acquisition is
    // proof that they have stopped, including during a rolling server update.
    legacyLock=!!(await legacyConnection`select pg_try_advisory_lock_shared(740023) as ok`)[0]?.ok;
    if(legacyLock)await legacyConnection`update jobs.job j set state='retry',start_after=now(),completed_on=null,
      retry_limit=greatest(retry_limit,retry_count+1),output='{"message":"Продолжение после обновления воркера"}'::jsonb
      where j.state='active' and j.name like 'heavy.%'
      and j.started_on<(select (value->>'at')::timestamptz from platform_runtime where key='worker-fleet-cutover')
      and not exists(select 1 from worker_jobs w where w.job_id=j.id)
      and not exists(select 1 from remote_worker_leases l where l.job_id=j.id)`;
  }finally{try{if(legacyLock)await legacyConnection`select pg_advisory_unlock_shared(740023)`;}finally{legacyConnection.release();}}
  const stale=await db.execute<{id:string}>(sql`select id from worker_instances where heartbeat_at<now()-interval '60 seconds'
    and not exists(select 1 from remote_worker_auth a where a.worker_id=worker_instances.id)
    and exists(select 1 from worker_jobs w where w.worker_id=worker_instances.id and w.finished_at is null
      and (exists(select 1 from jobs.job j where j.id=w.job_id and j.state='active')
        or exists(select 1 from automation_runs a where a.id=w.job_id and a.state='active')))`);
  for(const worker of stale){const connection=await db.sql.reserve();let acquired=false;try{
    const [lock]=await connection`select pg_try_advisory_lock(hashtextextended(${'worker:'+worker.id},0)) as ok`;
    if(!lock?.ok)continue;
    acquired=true;
    const jobs=await db.execute<{id:string;name:string}>(sql`select j.id::text,j.name from worker_jobs w join jobs.job j on j.id=w.job_id where w.worker_id=${worker.id} and w.finished_at is null and j.state='active'`);
    for(const job of jobs)await boss.fail(job.name,job.id,{message:'Воркер отключился; задание будет повторено с сохранённого этапа'});
    await db.execute(sql`update automation_runs set state='failed',completed_at=now()
      where state='active' and id in (select job_id from worker_jobs where worker_id=${worker.id} and finished_at is null)`);
    await db.execute(sql`update worker_jobs set finished_at=now() where worker_id=${worker.id} and finished_at is null`);
    await db.execute(sql`update worker_instances set state='offline' where id=${worker.id}`);
  }finally{
    try{if(acquired)await connection`select pg_advisory_unlock(hashtextextended(${'worker:'+worker.id},0))`;}
    finally{connection.release();}
  }}
}
