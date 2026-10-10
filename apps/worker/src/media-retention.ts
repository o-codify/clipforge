import {sql} from 'drizzle-orm';
import type {Database} from '@clipforge/db';
import type {MediaStorage,CacheManifest,CacheClip} from '@clipforge/storage';

// A YouTube ID alone is not proof of successful processing. Keep bytes for
// another pending destination, an uncertain upload, or an unfinished edit.
const retainClip=sql`c.media_released_at is null and (
  exists(select 1 from publications p where p.clip_id=c.id and p.status in ('queued','uploading','processing'))
  or ((c.archived_at is null and c.state<>'blocked') and (exists(
    select 1 from publications p where p.clip_id=c.id and p.status='failed' and p.media_id is null) or not exists(
    select 1 from publications p where p.clip_id=c.id and p.platform='youtube'
      and p.media_id is not null and p.status in ('published','uploaded')))))`;

export async function neededMediaVods(db:Database,finishedJobId?:string) {
  const rows=await db.execute<{id:string;active:boolean}>(sql`select id,bool_or(active) as active from (
    select coalesce(j.data->>'vodId',c.vod_id,r.vod_id) as id,j.state='active' as active
    from jobs.job j left join clips c on c.id=j.data->>'clipId' left join runs r on r.id=j.data->>'runId'
    where j.name like 'heavy.%' and j.name<>'heavy.archive-vod' and j.state in ('created','retry','active')
    ${finishedJobId?sql`and j.id<>${finishedJobId}::uuid`:sql``}
    union all select l.vod_id,true from remote_worker_leases l
    where l.state='active' and l.expires_at>now() and l.queue<>'heavy.archive-vod'
    ${finishedJobId?sql`and l.job_id<>${finishedJobId}::uuid`:sql``}
    ) activity group by id`);
  return {neededVods:rows.filter(r=>r.id).map(r=>r.id),activeVods:rows.filter(r=>r.id&&r.active).map(r=>r.id)};
}
export async function cacheManifest(db:Database,storage:MediaStorage,vodId?:string,finishedJobId?:string):Promise<CacheManifest> {
  const activity=await neededMediaVods(db,finishedJobId);
  // An unavailable object is never proof that its local copy can be deleted.
  let verificationComplete=true;
  const head=async(key:string)=>verificationComplete?storage.head(key,8000).catch(()=>{verificationComplete=false;return null;}):null;
  const clips=await db.execute<CacheClip&{media:{videoKey:string;posterKey:string}|null}>(sql`select c.id,c.vod_id as "vodId",c.run_id as "runId",c.version,c.file,r.out_dir as "outDir",c.media_storage as media,
    (${retainClip}) as keep
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

/** Keep only working sources and unpublished accepted renders. Clip records,
 * transcripts, metrics and publication history survive removal of the bytes. */
export async function pruneCloudMedia(db:Database,storage:MediaStorage,apply=true,now=Date.now()) {
  return db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(740027)`);
    const activity=await neededMediaVods(tx as unknown as Database),needed=new Set(activity.neededVods);
    const clipRows=await tx.execute<{id:string;vodId:string;keep:boolean;media:{videoKey:string;posterKey:string}|null}>(sql`
      select c.id,c.vod_id as "vodId",(${retainClip}) as keep,c.media_storage as media from clips c for update`);
    const keep=new Set(clipRows.filter(c=>c.keep||needed.has(c.vodId)).flatMap(c=>c.media?[c.media.videoKey,c.media.posterKey]:[]));
    const released=new Set(clipRows.filter(c=>!c.keep&&!needed.has(c.vodId)).flatMap(c=>c.media?[c.media.videoKey,c.media.posterKey]:[]));
    const sources=await tx.execute<{vodId:string;name:string;key:string}>(sql`select vod_id as "vodId",name,storage_key as key from vod_source_assets`);
    for(const source of sources)if(needed.has(source.vodId)&&source.name.startsWith('data/')&&!/\.(?:part|temp|pending)(?:\.|$)|\/source\.ts$/.test(source.name))keep.add(source.key);
    const protectedUploads=await tx.execute<{key:string}>(sql`select distinct u.storage_key as key from worker_object_uploads u join remote_worker_leases l on l.id=u.lease_id
      where l.state='active' and l.expires_at>now()
      union select u.storage_key as key from remote_worker_uploads u join remote_worker_leases l on l.id=u.lease_id
      where l.state='active' and l.expires_at>now()`);
    for(const u of protectedUploads)keep.add(u.key);
    let files=0,bytes=0,aborted=0;
    const remaining=new Set<string>();
    const objectVods=new Map(sources.map(s=>[s.key,s.vodId]));
    for(const c of clipRows)if(c.media)for(const key of [c.media.videoKey,c.media.posterKey])objectVods.set(key,c.vodId);
    const abandoned=await tx.execute<{id:string;key:string;multipart:string}>(sql`select u.id::text,u.storage_key as key,u.multipart_id as multipart from worker_object_uploads u
      join remote_worker_leases l on l.id=u.lease_id where u.state='receiving' and u.multipart_id is not null
      and u.created_at<${new Date(now-3600000).toISOString()}::timestamptz and (l.state<>'active' or l.expires_at<now())`);
    for(const u of abandoned){if(apply){await storage.abortMultipart(u.key,u.multipart);await tx.execute(sql`delete from worker_object_uploads where id=${u.id}::uuid`);}aborted++;}
    for await(const object of storage.mediaObjects()){
      remaining.add(object.key);
      if(keep.has(object.key)||!released.has(object.key)&&now-object.modified.getTime()<3600000)continue;
      const vodId=objectVods.get(object.key)??object.key.match(/\/(v\d+)(?:\/|_)/)?.[1];
      // An active pipeline may be between object upload and catalog commit.
      if(vodId&&activity.activeVods.includes(vodId))continue;
      if(vodId&&(await tx.execute(sql`select 1 from jobs.job j left join clips c on c.id=j.data->>'clipId' left join runs r on r.id=j.data->>'runId'
        where j.name like 'heavy.%' and j.name<>'heavy.archive-vod' and coalesce(j.data->>'vodId',c.vod_id,r.vod_id)=${vodId}
        and j.state in ('active','created','retry')
        union all select 1 from remote_worker_leases where vod_id=${vodId} and state='active' and expires_at>now() and queue<>'heavy.archive-vod' limit 1`)).length)continue;
      if(apply)await storage.removeMedia(object.key);files++;bytes+=object.size;remaining.delete(object.key);
    }
    if(apply){
      for(const source of sources)if(!remaining.has(source.key)&&!keep.has(source.key)&&!needed.has(source.vodId))await tx.execute(sql`delete from vod_source_assets where vod_id=${source.vodId} and name=${source.name}`);
      for(const c of clipRows)if(!c.keep&&!needed.has(c.vodId)&&(!c.media||[c.media.videoKey,c.media.posterKey].every(key=>!remaining.has(key)&&!keep.has(key))))
        await tx.execute(sql`update clips set media_storage=null,media_released_at=coalesce(media_released_at,now()) where id=${c.id}`);
      await tx.execute(sql`insert into platform_runtime(key,value) values('media-retention',${JSON.stringify({files,bytes,at:new Date().toISOString()})}::jsonb)
        on conflict(key) do update set value=excluded.value,updated_at=now()`);
    }
    return {files,bytes,aborted,apply};
  });
}
