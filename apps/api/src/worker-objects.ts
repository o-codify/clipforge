import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Database} from '@clipforge/db';
import type {MediaStorage} from '@clipforge/storage';
import type {MediaTaskScope} from '@clipforge/worker/media-task-repository';

export const OBJECT_PART_SIZE=8*1024*1024;
const name=z.string().min(1).max(700).refine(s=>!/[\\\x00-\x1f:]/.test(s)&&s.split('/').every(p=>p&&p!=='.'&&p!=='..'));
const uuid=z.string().uuid();
type ObjectRow={id:string;kind:string;name:string;clipId:string|null;size:number;sha256:string;mtimeNs:string;storageKey:string;multipartId:string|null;state:string};

/** Called only inside the gateway's active, worker-owned VOD lease. Signed
 * URLs grant access to one object/part, never to the bucket or its credentials. */
export class WorkerObjects {
  constructor(private db:Database,private storage:MediaStorage,private scope:MediaTaskScope){}
  private async row(id:string) {
    const [row]=await this.db.execute<ObjectRow>(sql`select *,size::float as size from worker_object_uploads where id=${uuid.parse(id)}::uuid and lease_id=${this.scope.leaseId}::uuid`);
    if(!row)throw new Error('Файл не принадлежит заданию');return row;
  }
  private async catalog(u:ObjectRow) {
    if(u.kind==='cache')await this.db.execute(sql`insert into vod_source_assets(vod_id,name,storage_key,size,sha256,mtime_ns)
      values(${this.scope.vodId},${u.name},${u.storageKey},${u.size},${u.sha256},${u.mtimeNs})
      on conflict(vod_id,name) do update set storage_key=excluded.storage_key,size=excluded.size,sha256=excluded.sha256,mtime_ns=excluded.mtime_ns,updated_at=now()`);
    else await this.db.execute(sql`insert into remote_worker_uploads(id,lease_id,clip_id,kind,size,sha256,received,state,storage_key)
      values(${u.id}::uuid,${this.scope.leaseId}::uuid,${u.clipId},${u.kind},${u.size},${u.sha256},${u.size},'stored',${u.storageKey})
      on conflict(lease_id,clip_id,kind) do update set size=excluded.size,sha256=excluded.sha256,received=excluded.received,state='stored',storage_key=excluded.storage_key`);
  }
  async start(raw:unknown) {
    const m=z.object({name,kind:z.enum(['cache','video','poster']),clipId:z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(220).optional(),
      size:z.number().int().positive().max(64*1024**3),sha256:z.string().regex(/^[a-f0-9]{64}$/),mtimeNs:z.string().regex(/^\d{1,20}$/).default('0')}).strict().parse(raw);
    if(!this.scope.vodId)throw new Error('Задание без эфира');
    if(m.kind==='cache'&&!/^(data|out)\//.test(m.name))throw new Error('Неверное имя исходника');
    if(m.kind!=='cache'&&(!m.clipId?.startsWith(this.scope.vodId+'_')||m.size>(m.kind==='poster'?2*1024**2:1024**3)))throw new Error('Клип не относится к заданию');
    const [old]=await this.db.execute<ObjectRow>(sql`select *,size::float as size from worker_object_uploads where lease_id=${this.scope.leaseId}::uuid and kind=${m.kind} and name=${m.name} and sha256=${m.sha256}`);
    if(old){
      if(old.size!==m.size)throw new Error('Размер файла изменился');
      if(old.state!=='stored'){
        const head=await this.storage.head(old.storageKey);
        if(head?.ContentLength===old.size&&head.Metadata?.sha256===old.sha256){await this.complete(old.id);old.state='stored';}
      }
      if(old.state==='stored')await this.catalog(old);
      const parts=old.state==='stored'?[]:await this.storage.multipartParts(old.storageKey,old.multipartId!);
      return {id:old.id,state:old.state,partSize:OBJECT_PART_SIZE,storageKey:old.storageKey,parts};
    }
    const id=randomUUID();
    // Reuse a verified clip object when archiving its old local working copy.
    const [known]=await this.db.execute<{key:string}>(sql`select u.storage_key as key from remote_worker_uploads u join remote_worker_leases l on l.id=u.lease_id
      where l.vod_id=${this.scope.vodId} and u.sha256=${m.sha256} and u.size=${m.size} and u.state='stored' limit 1`);
    const key=known?.key??`${this.storage.prefix}/sources/${this.scope.vodId}/${m.sha256}`;
    const head=await this.storage.head(key),stored=head?.ContentLength===m.size&&head.Metadata?.sha256===m.sha256;
    const multipart=stored?null:await this.storage.beginMultipart(key,m.sha256,m.kind==='poster'?'image/jpeg':m.kind==='video'?'video/mp4':'application/octet-stream');
    const u:ObjectRow={id,kind:m.kind,name:m.name,clipId:m.clipId??null,size:m.size,sha256:m.sha256,mtimeNs:m.mtimeNs,storageKey:key,multipartId:multipart,state:stored?'stored':'receiving'};
    await this.db.execute(sql`insert into worker_object_uploads(id,lease_id,kind,name,clip_id,size,sha256,mtime_ns,storage_key,multipart_id,state)
      values(${id}::uuid,${this.scope.leaseId}::uuid,${u.kind},${u.name},${u.clipId},${u.size},${u.sha256},${u.mtimeNs},${key},${multipart},${u.state})`);
    if(stored)await this.catalog(u);
    return {id,state:u.state,partSize:OBJECT_PART_SIZE,storageKey:key};
  }
  async part(id:string,raw:unknown) {
    const m=z.object({part:z.number().int().min(1).max(10000),md5:z.string().regex(/^[A-Za-z0-9+/]{22}==$/)}).strict().parse(raw),u=await this.row(id);
    const size=Math.min(OBJECT_PART_SIZE,u.size-(m.part-1)*OBJECT_PART_SIZE);
    if(!u.multipartId||u.state!=='receiving'||size<=0)throw new Error('Неверная часть файла');
    return {url:await this.storage.partUrl(u.storageKey,u.multipartId,m.part,size,m.md5),size};
  }
  async complete(id:string) {
    const u=await this.row(id);
    if(u.state!=='stored') {
      if(!u.multipartId)throw new Error('Загрузка не началась');
      await this.storage.finishMultipart(u.storageKey,u.multipartId,u.size,u.sha256,OBJECT_PART_SIZE);
      await this.db.execute(sql`update worker_object_uploads set state='stored' where id=${u.id}::uuid`);
    }
    await this.catalog(u);return {storageKey:u.storageKey};
  }
  async list() {
    return this.db.execute(sql`select name,size::float as size,sha256,mtime_ns as "mtimeNs" from vod_source_assets where vod_id=${this.scope.vodId} order by name`);
  }
  async read(raw:unknown) {
    const m=z.object({name,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw);
    const [asset]=await this.db.execute<{key:string}>(sql`select storage_key as key from vod_source_assets where vod_id=${this.scope.vodId} and name=${m.name} and sha256=${m.sha256}`);
    if(!asset)throw new Error('Исходник не найден');return {url:await this.storage.readUrl(asset.key,3600)};
  }
}
