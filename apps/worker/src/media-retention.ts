import {sql} from 'drizzle-orm';
import type {Database} from '@clipforge/db';
import type {MediaStorage,CacheManifest,CacheClip} from '@clipforge/storage';

export async function neededMediaVods(db:Database) {
  const rows=await db.execute<{id:string;active:boolean}>(sql`select distinct coalesce(j.data->>'vodId',c.vod_id) as id,bool_or(j.state='active') as active
    from jobs.job j left join clips c on c.id=j.data->>'clipId'
    where j.name like 'heavy.%' and j.name<>'heavy.archive-vod' and j.state in ('created','retry','active')
    group by coalesce(j.data->>'vodId',c.vod_id)`);
  return {neededVods:rows.filter(r=>r.id).map(r=>r.id),activeVods:rows.filter(r=>r.id&&r.active).map(r=>r.id)};
}
export async function cacheManifest(db:Database,storage:MediaStorage,vodId?:string):Promise<CacheManifest> {
  const activity=await neededMediaVods(db);
  // An unavailable object is never proof that its local copy can be deleted.
  let verificationComplete=true;
  const head=async(key:string)=>verificationComplete?storage.head(key,8000).catch(()=>{verificationComplete=false;return null;}):null;
  const clips=await db.execute<CacheClip&{media:{videoKey:string;posterKey:string}|null}>(sql`select c.id,c.vod_id as "vodId",c.run_id as "runId",c.version,c.file,r.out_dir as "outDir",c.media_storage as media,
    ((c.archived_at is null and c.state<>'blocked') or exists(select 1 from publications p where p.clip_id=c.id and p.media_id is not null)) as keep
    from clips c join runs r on r.id=c.run_id ${vodId?sql`where c.vod_id=${vodId}`:sql``}`);
  const result:CacheClip[]=[];
  // Bounded concurrency and only HEAD: no media download or bucket credentials.
  for(let i=0;i<clips.length;i+=4)result.push(...await Promise.all(clips.slice(i,i+4).map(async c=>{
    let cloud:CacheClip['cloud']=null;
    if(c.keep&&c.media){const [video,poster]=await Promise.all([head(c.media.videoKey),head(c.media.posterKey)]);
      if(video?.ContentLength&&video.Metadata?.sha256&&poster?.ContentLength)cloud={size:video.ContentLength,sha256:video.Metadata.sha256};}
    const {media,...row}=c;return {...row,cloud};
  })));
  const sourceRows=await db.execute<CacheManifest['sources'][number]&{key:string}>(sql`select vod_id as "vodId",name,size::float as size,sha256,storage_key as key from vod_source_assets ${vodId?sql`where vod_id=${vodId}`:sql``}`);
  const sources:CacheManifest['sources']=[];
  const neededSources=sourceRows.filter(row=>activity.neededVods.includes(row.vodId)&&row.name.startsWith('data/'));
  for(let i=0;i<neededSources.length;i+=4)await Promise.all(neededSources.slice(i,i+4).map(async row=>{
    const proof=await head(row.key);if(proof?.ContentLength===row.size&&proof.Metadata?.sha256===row.sha256){const {key,...asset}=row;sources.push(asset);}
  }));
  return {...activity,clips:result,sources,generatedAt:new Date().toISOString(),verificationComplete};
}

/** Catalog references, not upload history, determine retention. Rejected and
 * superseded renders lose their bytes; rejection reasons remain in the DB. */
export async function pruneCloudMedia(db:Database,storage:MediaStorage,apply=true,now=Date.now()) {
  return db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(740027)`);
    const activity=await neededMediaVods(tx as unknown as Database),needed=new Set(activity.neededVods);
    const clipRows=await tx.execute<{media:{videoKey:string;posterKey:string}|null}>(sql`select c.media_storage as media from clips c
      where (c.archived_at is null and c.state<>'blocked') or exists(select 1 from publications p where p.clip_id=c.id and p.media_id is not null)`);
    const keep=new Set(clipRows.flatMap(c=>c.media?[c.media.videoKey,c.media.posterKey]:[]));
    const sources=await tx.execute<{vodId:string;name:string;key:string}>(sql`select vod_id as "vodId",name,storage_key as key from vod_source_assets`);
    for(const source of sources)if(needed.has(source.vodId)&&source.name.startsWith('data/')&&!/\.(?:part|temp|pending)(?:\.|$)|\/source\.ts$/.test(source.name))keep.add(source.key);
    const protectedUploads=await tx.execute<{key:string}>(sql`select distinct u.storage_key as key from worker_object_uploads u join remote_worker_leases l on l.id=u.lease_id
      where l.state='active' and l.expires_at>now()`);
    for(const u of protectedUploads)keep.add(u.key);
    let files=0,bytes=0,aborted=0;
    const abandoned=await tx.execute<{id:string;key:string;multipart:string}>(sql`select u.id::text,u.storage_key as key,u.multipart_id as multipart from worker_object_uploads u
      join remote_worker_leases l on l.id=u.lease_id where u.state='receiving' and u.multipart_id is not null
      and u.created_at<${new Date(now-3600000).toISOString()}::timestamptz and (l.state<>'active' or l.expires_at<now())`);
    for(const u of abandoned){if(apply){await storage.abortMultipart(u.key,u.multipart);await tx.execute(sql`delete from worker_object_uploads where id=${u.id}::uuid`);}aborted++;}
    for await(const object of storage.mediaObjects()){
      if(keep.has(object.key)||now-object.modified.getTime()<3600000)continue;
      const vodId=object.key.match(/\/(v\d+)(?:\/|_)/)?.[1];
      // An active pipeline may be between object upload and catalog commit.
      if(vodId&&activity.activeVods.includes(vodId))continue;
      if(vodId&&(await tx.execute(sql`select 1 from jobs.job where name like 'heavy.%' and name<>'heavy.archive-vod'
        and data->>'vodId'=${vodId} and state in ('active','created','retry') limit 1`)).length)continue;
      if(apply)await storage.removeMedia(object.key);files++;bytes+=object.size;
    }
    if(apply){
      for(const source of sources)if(!keep.has(source.key)&&!activity.activeVods.includes(source.vodId))await tx.execute(sql`delete from vod_source_assets where vod_id=${source.vodId} and name=${source.name}`);
      await tx.execute(sql`update clips c set media_storage=null where (c.archived_at is not null or c.state='blocked')
        and not exists(select 1 from publications p where p.clip_id=c.id and p.media_id is not null)
        and not exists(select 1 from remote_worker_leases l where l.vod_id=c.vod_id and l.state='active' and l.expires_at>now())`);
      await tx.execute(sql`insert into platform_runtime(key,value) values('media-retention',${JSON.stringify({files,bytes,at:new Date().toISOString()})}::jsonb)
        on conflict(key) do update set value=excluded.value,updated_at=now()`);
    }
    return {files,bytes,aborted,apply};
  });
}
