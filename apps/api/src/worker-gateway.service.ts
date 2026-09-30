import {Inject,Injectable,UnauthorizedException,ConflictException,BadRequestException,NotFoundException,type OnModuleDestroy} from '@nestjs/common';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {type Database} from '@clipforge/db';
import {PAYLOADS,QUEUES,type QueueName} from '@clipforge/jobs';
import {storageFromEnv,type MediaStorage} from '@clipforge/storage';
import {MediaTaskRepository,type MediaTaskScope} from '@clipforge/worker/media-task-repository';
import {z} from 'zod';
import {CONFIG,DATABASE,REPO_ROOT,type ApiConfig} from './config.js';
import {JobsService} from './jobs/jobs.service.js';

const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const opaque=z.string().regex(/^[a-zA-Z0-9_-]{43,128}$/);
const uid=z.string().uuid();
const fileId=z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,219}$/).refine(s=>!s.includes('..'));
// One active assignment, batch size 1: 4 GiB for speech admission plus the
// runtime, bounded media windows and a reserve. Users need not size each task.
export const WORKER_PROFILE={cpu:2,memoryGb:6,downloadKbps:10000,uploadKbps:5000} as const;
type Policy={cpu:number;memoryGb:number;downloadKbps:number;uploadKbps:number};
const resourcesSchema=z.object({allocation:z.object({cpus:z.number().positive().max(1024),memoryMb:z.number().positive().max(1048576),usedMb:z.number().nonnegative().max(1048576)}),
  freeGb:z.number().nonnegative().max(1000000),paused:z.boolean(),reason:z.string().max(100).nullable().optional(),memoryMb:z.number().nonnegative().optional(),
  cpuPercent:z.number().min(0).max(100).optional(),downloadKbps:z.number().nonnegative().optional(),uploadKbps:z.number().nonnegative().optional(),
  metrics:z.object({ownMemoryMb:z.number().nonnegative(),freeMb:z.number().nonnegative().optional(),totalMb:z.number().nonnegative().optional()}).optional()});
const mediaQueues=Object.values(QUEUES).filter(q=>q.startsWith('heavy.')&&q!==QUEUES.prepareStreamer);
type Lease=MediaTaskScope&{workerId:string;state:string};
type Worker={workerId:string;policy:Policy};
type Upload={id:string;clipId:string;kind:'video'|'poster';size:number;sha256:string;received:number;state:string;storageKey:string|null};
const uploadColumns=sql`id::text,clip_id as "clipId",kind,size::float,sha256,received::float,state,storage_key as "storageKey"`;

@Injectable()
export class WorkerGatewayService implements OnModuleDestroy {
  private readonly storage:MediaStorage|null;
  private readonly timer:NodeJS.Timeout;
  private sweeping=false;
  constructor(@Inject(DATABASE) private readonly db:Database,@Inject(CONFIG) private readonly config:ApiConfig,private readonly jobs:JobsService){
    this.storage=storageFromEnv();
    this.timer=setInterval(()=>{void this.sweep().catch(()=>{});},15000);this.timer.unref();
  }
  onModuleDestroy(){clearInterval(this.timer);}
  private context(db=this.db){return {db,config:{out:this.config.out}};}
  private async identity(auth:string|undefined,db=this.db):Promise<Worker>{
    const token=auth?.match(/^Bearer ([a-zA-Z0-9_-]{43,128})$/)?.[1];if(!token)throw new UnauthorizedException('Нужен ключ воркера');
    const [w]=await db.execute<Worker>(sql`select worker_id as "workerId",policy from remote_worker_auth where secret_hash=${hash(token)} and revoked_at is null`);
    if(!w)throw new UnauthorizedException('Доступ воркера отозван');return w;
  }
  async connect(raw:unknown){
    const input=z.object({label:z.string().trim().min(1).max(80).default('Воркер')}).strict().parse(raw);
    const token=randomBytes(32).toString('base64url'),id=randomUUID(),name='clipforge-'+id.slice(0,8),expiresAt=new Date(Date.now()+3600000);
    // Origin is configured by the platform; a request Host header cannot inject shell code.
    const origin=new URL(this.config.webOrigin).origin;if(!/^https?:\/\/[a-zA-Z0-9.:-]+$/.test(origin))throw new Error('Неверный адрес платформы');
    await this.db.execute(sql`insert into remote_worker_enrollments(id,token_hash,label,policy,expires_at) values(${id}::uuid,${hash(token)},${input.label},${JSON.stringify(WORKER_PROFILE)}::jsonb,${expiresAt.toISOString()}::timestamptz)`);
    const launcher="fetch(process.argv[1]+'/api/worker-gateway/bootstrap').then(r=>{if(!r.ok)throw Error('Platform unavailable');return r.text()}).then(s=>require('fs').writeFileSync('/tmp/clipforge-bootstrap.cjs',s)).then(()=>require('/tmp/clipforge-bootstrap.cjs')).catch(()=>process.exit(1))";
    const p=WORKER_PROFILE;
    const command=`docker run -d --name ${name} --restart unless-stopped --init --cpus=${p.cpu} --cpu-shares=256 --memory=${p.memoryGb}g --memory-swap=${p.memoryGb}g --pids-limit=256 --mount source=${name},target=/storage node:22-bookworm-slim node -e "${launcher}" ${origin} ${token}`;
    return {command,expiresAt,name};
  }
  async enroll(raw:unknown){
    const m=z.object({key:opaque,secret:opaque,host:z.string().max(120)}).strict().parse(raw);
    return this.db.transaction(async tx=>{
      const [e]=await tx.execute<{id:string;label:string;policy:Policy;workerId:string|null;valid:boolean}>(sql`select id,label,policy,worker_id as "workerId",expires_at>now() as valid from remote_worker_enrollments where token_hash=${hash(m.key)} for update`);
      if(!e)throw new UnauthorizedException('Ключ подключения недействителен');
      if(e.workerId){const [w]=await tx.execute(sql`select 1 from remote_worker_auth where worker_id=${e.workerId} and secret_hash=${hash(m.secret)} and revoked_at is null`);
        if(!w)throw new UnauthorizedException('Ключ подключения уже использован');return {workerId:e.workerId,policy:e.policy};}
      if(!e.valid)throw new UnauthorizedException('Срок команды подключения истёк');
      const workerId='remote-'+e.id;
      await tx.execute(sql`insert into worker_instances(id,label,host,role,queues,state) values(${workerId},${e.label},${m.host},'media',${JSON.stringify(mediaQueues)}::jsonb,'installing')`);
      await tx.execute(sql`insert into remote_worker_auth(worker_id,secret_hash,policy) values(${workerId},${hash(m.secret)},${JSON.stringify(e.policy)}::jsonb)`);
      await tx.execute(sql`update remote_worker_enrollments set worker_id=${workerId} where id=${e.id}::uuid`);
      return {workerId,policy:e.policy};
    });
  }
  async bootstrap(){return readFile(join(REPO_ROOT,'scripts','remote-worker-bootstrap.cjs'),'utf8');}
  async bundle(auth:string|undefined){await this.identity(auth);return join(REPO_ROOT,'worker-bundle.tar.gz');}
  async manifest(auth:string|undefined){const worker=await this.identity(auth),file=await this.bundle(auth);
    const meta=JSON.parse(await readFile(file+'.json','utf8')) as {sha256:string;size:number};return {...meta,version:process.env.RELEASE_SHA??'local',policy:worker.policy};}
  async revoke(id:string){
    const rows=await this.db.execute(sql`update remote_worker_auth set revoked_at=now() where worker_id=${z.string().max(128).parse(id)} returning worker_id`);
    if(!rows.length)throw new NotFoundException('Удалённый воркер не найден');
    await this.db.execute(sql`update worker_instances set draining=true,state='revoked' where id=${id}`);await this.sweep();return {revoked:true};
  }
  async installation(auth:string|undefined,raw:unknown){const w=await this.identity(auth),m=z.object({stage:z.string().max(120)}).parse(raw);
    await this.db.execute(sql`update worker_instances set state='installing',heartbeat_at=now(),resources=${JSON.stringify({stage:m.stage})}::jsonb where id=${w.workerId}`);return {};}
  async heartbeat(auth:string|undefined,raw:unknown){const w=await this.identity(auth);
    const m=z.object({resources:resourcesSchema,leaseId:uid.nullable(),version:z.string().max(100)}).parse(raw);
    const [r]=await this.db.execute<{draining:boolean}>(sql`update worker_instances set resources=${JSON.stringify(m.resources)}::jsonb,version=${m.version},state='online',heartbeat_at=now() where id=${w.workerId} returning draining`);
    let accepted=!m.leaseId;
    if(m.leaseId){await this.db.transaction(async tx=>{
      const [lease]=await tx.execute<{jobId:string}>(sql`update remote_worker_leases l set expires_at=now()+interval '75 seconds'
        where l.id=${m.leaseId}::uuid and l.worker_id=${w.workerId} and l.state='active' and l.expires_at>now()
        and exists(select 1 from jobs.job j where j.id=l.job_id and j.state='active')
        and (l.payload->>'batchId' is null or exists(select 1 from jobs.job j where j.id=(l.payload->>'batchId')::uuid and j.state='active')) returning job_id as "jobId"`);
      if(lease){accepted=true;await tx.execute(sql`update worker_jobs set heartbeat_at=now() where job_id=${lease.jobId}::uuid and worker_id=${w.workerId}`);
        // Resource pauses must not expire a healthy worker's media job.
        await tx.execute(sql`update jobs.job set expire_in=greatest(expire_in,now()-started_on+interval '2 minutes') where id=${lease.jobId}::uuid and state='active'`);}
    });}
    return {accepted,draining:r?.draining??true,policy:w.policy,leaseSeconds:75,upgradeRequired:!!process.env.RELEASE_SHA&&m.version!==process.env.RELEASE_SHA};
  }
  private async withLease<T>(auth:string|undefined,leaseId:string,action:(repo:MediaTaskRepository,db:Database,scope:Lease)=>Promise<T>):Promise<T>{
    return this.db.transaction(async tx=>{
      const db=tx as unknown as Database,w=await this.identity(auth,db);
      // Revocation and lease expiry serialize with all catalog writes.
      const authorized=await tx.execute(sql`select worker_id from remote_worker_auth where worker_id=${w.workerId} and revoked_at is null for share`);
      if(!authorized.length)throw new UnauthorizedException('Доступ воркера отозван');
      const [l]=await tx.execute<Lease>(sql`select l.id as "leaseId",l.job_id as "jobId",l.worker_id as "workerId",l.queue,l.vod_id as "vodId",l.payload,l.state from remote_worker_leases l
        join jobs.job j on j.id=l.job_id where l.id=${uid.parse(leaseId)}::uuid and l.worker_id=${w.workerId} and l.state='active' and l.expires_at>now() and j.state='active'
        and (l.payload->>'batchId' is null or exists(select 1 from jobs.job p where p.id=(l.payload->>'batchId')::uuid and p.state='active')) for update of l`);
      if(!l)throw new ConflictException('Задание больше не принадлежит этому воркеру');
      return action(new MediaTaskRepository(this.context(db),l),db,l);
    });
  }
  async next(auth:string|undefined){const w=await this.identity(auth);await this.sweep();await this.jobs.queue();
    // A pre-gateway binary cannot see durable VOD assignments. Wait for its
    // normal rolling upgrade; never race a still-running native batch.
    const [legacy]=await this.db.execute(sql`select 1 from worker_instances w where w.role in ('media','all') and w.state='online'
      and w.heartbeat_at>now()-interval '75 seconds' and coalesce(w.resources->>'leaseProtocol','0')<>'1'
      and not exists(select 1 from remote_worker_auth a where a.worker_id=w.id)
      union all select 1 from platform_runtime where key='worker' and value->>'workerId' is null and value->>'state'='online' and updated_at>now()-interval '75 seconds' limit 1`);
    if(legacy)return null;
    return this.db.transaction(async tx=>{
      const [worker]=await tx.execute<{resources:z.infer<typeof resourcesSchema>;draining:boolean;fresh:boolean;version:string}>(sql`select resources,draining,version,heartbeat_at>now()-interval '30 seconds' as fresh from worker_instances where id=${w.workerId} for update`);
      if(!(await tx.execute(sql`select 1 from remote_worker_auth where worker_id=${w.workerId} and revoked_at is null for share`)).length)throw new UnauthorizedException();
      const parsed=resourcesSchema.safeParse(worker?.resources);
      if(!worker||worker.draining||!worker.fresh||!parsed.success||parsed.data.paused||(process.env.RELEASE_SHA&&worker.version!==process.env.RELEASE_SHA))return null;
      const resources=parsed.data;
      if(resources.freeGb<4||resources.allocation.memoryMb-resources.allocation.usedMb<Math.max(256,resources.allocation.memoryMb*.1))return null;
      const [active]=await tx.execute(sql`select 1 from remote_worker_leases where worker_id=${w.workerId} and state='active'`);if(active)return null;
      const candidates=await tx.execute<{id:string;name:QueueName;data:Record<string,unknown>}>(sql`select j.id::text,j.name,j.data from jobs.job j
        where j.name in (${sql.join(mediaQueues.map(q=>sql`${q}`),sql`,`)}) and j.state in ('created','retry') and j.start_after<now()
        and coalesce(j.policy,'standard')='standard' and j.data->>'vodId' is not null
        and not exists(select 1 from remote_worker_leases l where l.vod_id=j.data->>'vodId' and l.state='active')
        and not exists(select 1 from jobs.job other where other.id<>j.id and other.state='active' and other.name like 'heavy.%' and other.data->>'vodId'=j.data->>'vodId')
        and (j.data->>'batchId' is null or exists(select 1 from jobs.job p where p.id=(j.data->>'batchId')::uuid and p.state='active'))
        order by j.priority desc,j.created_on,j.id limit 20 for update skip locked`);
      for(const job of candidates){
        const data=PAYLOADS[job.name].parse(job.data) as Record<string,unknown>,vodId=String(data.vodId);if(!/^v[0-9]+$/.test(vodId))continue;
        const [lock]=await tx.execute<{ok:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'vod:'+vodId},0)) as ok`);if(!lock?.ok)continue;
        const [busy]=await tx.execute(sql`select 1 from remote_worker_leases where vod_id=${vodId} and state='active'`);if(busy)continue;
        const needsSpeech=[QUEUES.pipeline,QUEUES.preparePreview,QUEUES.prepareBatchVod,QUEUES.transcribeVod].includes(job.name as never);
        const speechModel=process.env.SPEECH_MODEL??'large-v3',headroom=/large/.test(speechModel)?4608:2048;
        if(needsSpeech&&resources.allocation.memoryMb*.9<headroom)continue;
        const leaseId=randomUUID();
        await tx.execute(sql`update jobs.job set state='active',retry_count=case when started_on is null then retry_count else retry_count+1 end,started_on=now() where id=${job.id}::uuid`);
        await tx.execute(sql`insert into remote_worker_leases(id,job_id,worker_id,queue,vod_id,payload,expires_at) values(${leaseId}::uuid,${job.id}::uuid,${w.workerId},${job.name},${vodId},${JSON.stringify(data)}::jsonb,now()+interval '75 seconds')`);
        await tx.execute(sql`insert into worker_jobs(job_id,worker_id) values(${job.id}::uuid,${w.workerId}) on conflict(job_id) do update set worker_id=excluded.worker_id,started_at=now(),heartbeat_at=now(),finished_at=null,stage=null`);
        if(job.name===QUEUES.pipeline)await tx.execute(sql`insert into pipeline_attempts(vod_id,attempts,state) values(${vodId},1,'running') on conflict(vod_id) do update set attempts=pipeline_attempts.attempts+1,state='running',updated_at=now()`);
        return {leaseId,jobId:job.id,queue:job.name,payload:data,settings:{speechModel,speechLanguage:process.env.SPEECH_LANGUAGE??'ru',videoFormat:this.config.videoFormat,clipsPerRun:this.config.clipsPerRun,glossary:(process.env.SPEECH_GLOSSARY??'').split('|').filter(Boolean)},policy:w.policy};
      }return null;
    });
  }
  async operation(auth:string|undefined,leaseId:string,raw:unknown){const m=z.object({operation:z.string().max(50),input:z.unknown()}).strict().parse(raw);
    return this.withLease(auth,leaseId,repo=>repo.call(m.operation,m.input));}
  async progress(auth:string|undefined,leaseId:string,raw:unknown){const m=z.object({messages:z.array(z.string().max(500)).max(30)}).parse(raw);
    return this.withLease(auth,leaseId,async(_,db,l)=>{
      const last=m.messages.at(-1);if(last)await db.execute(sql`update worker_jobs set stage=${last},heartbeat_at=now() where job_id=${l.jobId}::uuid and worker_id=${l.workerId}`);
      if(m.messages.length)await db.execute(sql`insert into job_events(job_id,message) values ${sql.join(m.messages.map(message=>sql`(${l.jobId}::uuid,${message})`),sql`,`)}`);return {};});}
  async finish(auth:string|undefined,leaseId:string,raw:unknown){const m=z.object({ok:z.boolean(),output:z.record(z.unknown()).default({}),error:z.string().max(2000).optional()}).parse(raw);
    const w=await this.identity(auth);const [old]=await this.db.execute<{state:string}>(sql`select state from remote_worker_leases where id=${uid.parse(leaseId)}::uuid and worker_id=${w.workerId}`);
    if(old&&['completed','failed'].includes(old.state))return {accepted:true};
    return this.withLease(auth,leaseId,async(_,db,l)=>{
      if(m.ok)await db.execute(sql`update jobs.job set state='completed',completed_on=now(),output=${JSON.stringify(m.output)}::jsonb where id=${l.jobId}::uuid and state='active'`);
      else await this.retry(db,l.jobId,m.error??'Воркер не завершил задание');
      if(l.queue===QUEUES.pipeline)await db.execute(sql`update pipeline_attempts set state=${m.ok?'completed':'failed'},error=${m.ok?null:(m.error??'Не завершено').slice(0,1000)},updated_at=now() where vod_id=${l.vodId}`);
      await db.execute(sql`update remote_worker_leases set state=${m.ok?'completed':'failed'},finished_at=now() where id=${leaseId}::uuid`);
      await db.execute(sql`update worker_jobs set finished_at=now() where job_id=${l.jobId}::uuid and worker_id=${l.workerId}`);return {accepted:true};});
  }
  private async retry(db:Database,jobId:string,message:string){
    await db.execute(sql`update jobs.job set state=case when retry_count<retry_limit then 'retry'::jobs.job_state else 'failed'::jobs.job_state end,
      completed_on=case when retry_count<retry_limit then null else now() end,
      start_after=now()+(greatest(1,retry_delay)*case when retry_backoff then power(2,least(16,retry_count)) else 1 end)*interval '1 second',
      output=${JSON.stringify({message})}::jsonb where id=${jobId}::uuid and state='active'`);
  }
  async sweep(){if(this.sweeping)return;this.sweeping=true;
    try{await this.db.transaction(async tx=>{const leases=await tx.execute<{leaseId:string;jobId:string;workerId:string}>(sql`select l.id as "leaseId",l.job_id as "jobId",l.worker_id as "workerId" from remote_worker_leases l
        join remote_worker_auth a on a.worker_id=l.worker_id left join jobs.job j on j.id=l.job_id
        where l.state='active' and (l.expires_at<now() or a.revoked_at is not null or j.state is distinct from 'active'
          or (l.payload->>'batchId' is not null and not exists(select 1 from jobs.job p where p.id=(l.payload->>'batchId')::uuid and p.state='active')))
        for update of l skip locked`);
      for(const l of leases){await this.retry(tx as unknown as Database,l.jobId,'Связь с воркером потеряна; продолжение с сохранённого этапа');
        await tx.execute(sql`update remote_worker_leases set state='expired',finished_at=now() where id=${l.leaseId}::uuid`);
        await tx.execute(sql`update worker_jobs set finished_at=now() where job_id=${l.jobId}::uuid and worker_id=${l.workerId}`);}
    });
      // A failed or revoked assignment must not retain partial videos forever.
      // Only server-generated UUID files from inactive leases are eligible.
      const abandoned=await this.db.execute<{id:string}>(sql`select u.id::text from remote_worker_uploads u
        join remote_worker_leases l on l.id=u.lease_id where u.state='receiving' and l.state<>'active'
        and l.finished_at<now()-interval '15 minutes' order by u.created_at limit 100`);
      for(const u of abandoned){await rm(this.uploadFile(u.id),{force:true});await this.db.execute(sql`delete from remote_worker_uploads where id=${u.id}::uuid and state='receiving'`);}
    }finally{this.sweeping=false;}
  }
  private uploadFile(id:string){return join(this.config.data,'worker-uploads',uid.parse(id)+'.part');}
  async beginUpload(auth:string|undefined,leaseId:string,raw:unknown){
    const m=z.object({clipId:fileId,kind:z.enum(['video','poster']),size:z.number().int().positive().max(1024**3),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw);
    if(m.kind==='poster'&&m.size>2*1024**2)throw new BadRequestException('Слишком большая обложка');
    return this.withLease(auth,leaseId,async(_,db,l)=>{
      if(!m.clipId.startsWith(l.vodId+'_'))throw new BadRequestException('Файл не относится к заданному эфиру');
      const [count]=await db.execute<{n:number}>(sql`select count(*)::int n from remote_worker_uploads where lease_id=${leaseId}::uuid`);if((count?.n??0)>=1000)throw new BadRequestException('Слишком много файлов');
      await db.execute(sql`insert into remote_worker_uploads(id,lease_id,clip_id,kind,size,sha256) values(${randomUUID()}::uuid,${leaseId}::uuid,${m.clipId},${m.kind},${m.size},${m.sha256}) on conflict(lease_id,clip_id,kind) do nothing`);
      const [u]=await db.execute<Upload>(sql`select ${uploadColumns} from remote_worker_uploads where lease_id=${leaseId}::uuid and clip_id=${m.clipId} and kind=${m.kind}`);
      if(!u||u.sha256!==m.sha256||u.size!==m.size)throw new ConflictException('Файл уже передаётся с другим содержимым');return u;
    });
  }
  async chunk(auth:string|undefined,leaseId:string,uploadId:string,raw:unknown){
    const m=z.object({offset:z.number().int().nonnegative(),data:z.string().max(1500000)}).strict().parse(raw),bytes=Buffer.from(m.data,'base64');
    if(!bytes.length||bytes.length>1024**2)throw new BadRequestException('Неверный размер части');
    return this.withLease(auth,leaseId,async(_,db)=>{
      const [u]=await db.execute<Upload>(sql`select ${uploadColumns} from remote_worker_uploads where id=${uid.parse(uploadId)}::uuid and lease_id=${leaseId}::uuid for update`);
      if(!u||m.offset+bytes.length>u.size||m.offset>u.received)throw new ConflictException('Неверное смещение');
      if(u.state==='stored')return {received:u.received};
      const file=this.uploadFile(u.id);await mkdir(join(this.config.data,'worker-uploads'),{recursive:true});
      const f=await open(file,(await stat(file).catch(()=>null))?'r+':'w+');
      try{if(m.offset<u.received){const existing=Buffer.alloc(bytes.length);await f.read(existing,0,bytes.length,m.offset);if(!existing.equals(bytes))throw new ConflictException('Повторная часть отличается');return {received:u.received};}
        await f.write(bytes,0,bytes.length,m.offset);await f.sync();
        await db.execute(sql`update remote_worker_uploads set received=${m.offset+bytes.length} where id=${u.id}::uuid`);return {received:m.offset+bytes.length};
      }finally{await f.close();}
    });
  }
  async commitUpload(auth:string|undefined,leaseId:string,uploadId:string){
    const u=await this.withLease(auth,leaseId,async(_,db)=>{const [u]=await db.execute<Upload>(sql`select ${uploadColumns} from remote_worker_uploads where id=${uid.parse(uploadId)}::uuid and lease_id=${leaseId}::uuid`);if(!u)throw new NotFoundException();return u;});
    if(u.state==='stored')return u;
    if(u.received!==u.size)throw new ConflictException('Файл передан не полностью');
    const file=this.uploadFile(u.id),sum=createHash('sha256');for await(const chunk of createReadStream(file))sum.update(chunk);
    if(sum.digest('hex')!==u.sha256)throw new BadRequestException('Контрольная сумма файла не совпала');
    if(!this.storage)throw new ConflictException('Хранилище платформы недоступно');
    const key=`${this.storage.prefix}/worker-results/${leaseId}/${u.id}.${u.kind==='video'?'mp4':'jpg'}`;
    await this.storage.uploadFile(key,file,u.kind==='video'?'video/mp4':'image/jpeg');
    await this.withLease(auth,leaseId,async(_,db)=>{await db.execute(sql`update remote_worker_uploads set state='stored',storage_key=${key} where id=${u.id}::uuid`);});
    await rm(file,{force:true});return {...u,state:'stored',storageKey:key};
  }
  async source(auth:string|undefined,leaseId:string,clipId:string){
    const row=await this.withLease(auth,leaseId,repo=>repo.clip(fileId.parse(clipId)));
    if(!row.clip||!row.run)throw new NotFoundException();
    if(row.clip.mediaStorage&&this.storage)return this.storage.openVideo(row.clip.mediaStorage.videoKey);
    // Only trusted, catalogued server paths, never a path from the request.
    const file=join(row.run.outDir,row.clip.file);return {body:createReadStream(file),size:(await stat(file)).size};
  }
}
