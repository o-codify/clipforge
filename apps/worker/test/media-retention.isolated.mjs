// Local disposable PostgreSQL + in-memory object storage. No production access,
// media download, rendering, or YouTube uploads.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {createDatabase} from '../../../packages/db/dist/client.js';
import {MediaStorage,cleanLocalCache} from '../../../packages/storage/dist/index.js';
import {pruneCloudMedia,cacheManifest,neededMediaVods} from '../dist/media-retention.js';

const docker=(...args)=>execFileSync('docker',args,{windowsHide:true,encoding:'utf8',timeout:60000}).trim();
const name='cf-retention-qa-'+randomUUID().slice(0,8),objects=new Map(),removed=[],aborted=[];
const old=new Date(Date.now()-7200000),fresh=new Date();let db,dir,failKey;
const put=(key,modified=old)=>objects.set(key,{Key:key,Size:100,LastModified:modified});
const storage=new MediaStorage({send:async command=>{
  const {Key:key,Prefix:prefix}=command.input;
  switch(command.constructor.name){
    case 'ListObjectsV2Command':return {Contents:[...objects.values()].filter(o=>o.Key.startsWith(prefix))};
    case 'DeleteObjectCommand':if(key===failKey)throw Error('fixture delete failure');removed.push(key);objects.delete(key);return {};
    case 'HeadObjectCommand':if(!objects.has(key))throw {$metadata:{httpStatusCode:404}};return {ContentLength:100,Metadata:{sha256:'fixture'}};
    case 'AbortMultipartUploadCommand':aborted.push(key);return {};
    default:throw Error('Unexpected storage operation '+command.constructor.name);
  }
}},'fixture','clipforge');
try{
  docker('run','-d','--name',name,'--memory=256m','--cpus=.5','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=fixture','postgres:17-alpine');
  const port=JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  db=createDatabase({url:`postgres://postgres:fixture@127.0.0.1:${port}/postgres`,max:3});
  for(let i=0;;i++){try{await db.sql`select 1`;break;}catch(e){if(i>40)throw e;await new Promise(r=>setTimeout(r,250));}}
  await db.sql.unsafe(`create schema jobs;
    create table jobs.job(id uuid,name text,state text,data jsonb);
    create table runs(id text,vod_id text,out_dir text);
    create table clips(id text primary key,vod_id text,run_id text,version text,file text,state text,archived_at timestamptz,media_storage jsonb,media_released_at timestamptz);
    create table publications(id text,clip_id text,platform text,media_id text,status text);
    create table vod_source_assets(vod_id text,name text,storage_key text,size bigint,sha256 text,mtime_ns text);
    create table remote_worker_leases(id uuid,job_id uuid,vod_id text,queue text,state text,expires_at timestamptz);
    create table worker_object_uploads(id uuid,lease_id uuid,storage_key text,state text,multipart_id text,created_at timestamptz);
    create table remote_worker_uploads(lease_id uuid,storage_key text);
    create table platform_runtime(key text primary key,value jsonb,updated_at timestamptz default now());`);
  let seq=100;
  const clip=async(id,status,{active=false,blocked=false,young=false,prefix='clips',mediaId=true}={})=>{
    const vod='v'+seq++,video=`clipforge/${prefix}/${id}/video.mp4`,poster=`clipforge/${prefix}/${id}/poster.jpg`;
    put(video,young?fresh:old);put(poster,young?fresh:old);
    await db.sql`insert into runs values(${id},${vod},${'C:/cache/out/dota/sany/'+vod+'/'+id})`;
    await db.sql`insert into clips values(${id},${vod},${id},'version','video.mp4',${blocked?'blocked':'ready'},null,${JSON.stringify({videoKey:video,posterKey:poster})}::jsonb,null)`;
    if(status)await db.sql`insert into publications values(${id},${id},'youtube',${mediaId?'abcdefghijk':null},${status})`;
    if(active)await db.sql`insert into jobs.job values(${randomUUID()},'heavy.clean-clip','active',${JSON.stringify({clipId:id})}::jsonb)`;
    return {vod,video,poster};
  };
  const published=await clip('published','published',{young:true,prefix:'worker-results'});
  const privateUpload=await clip('private','uploaded');
  const processing=await clip('processing','processing');
  const failed=await clip('failed','failed',{mediaId:false});
  const rejectedUpload=await clip('upload-rejected','failed');
  const active=await clip('active','published',{active:true});
  const pending=await clip('pending','published');
  await db.sql`insert into publications values('second','pending','youtube',null,'queued')`;
  const draft=await clip('draft',null);
  const blocked=await clip('blocked',null,{blocked:true});
  const shared=await clip('shared','published');
  await db.sql`update clips set media_storage=${JSON.stringify({videoKey:shared.video,posterKey:shared.poster})}::jsonb where id='draft'`;
  const source='clipforge/sources/v900/source',neededSource='clipforge/sources/v901/source',orphan='clipforge/worker-results/unused/old.mp4',youngOrphan='clipforge/worker-results/unused/new.mp4';
  for(const key of [source,neededSource,orphan])put(key);put(youngOrphan,fresh);put('clipforge/checks/untouched');
  for(const [vod,key] of [['v900',source],['v901',neededSource]])await db.sql`insert into vod_source_assets values(${vod},'data/video.mp4',${key},100,'fixture','0')`;
  const task=randomUUID(),lease=randomUUID();
  await db.sql`insert into jobs.job values(${task},'heavy.pipeline','active','{"vodId":"v901"}')`;
  await db.sql`insert into remote_worker_leases values(${lease},${task},'v901','heavy.pipeline','active',now()+interval '1 hour')`;
  const live='clipforge/worker-results/in-flight/file.mp4';put(live);
  await db.sql`insert into remote_worker_uploads values(${lease},${live})`;
  assert((await neededMediaVods(db)).neededVods.includes('v901'));
  assert(!(await neededMediaVods(db,task)).neededVods.includes('v901'),'a finished task must not archive sources just for itself');
  const deadLease=randomUUID(),multipart='clipforge/sources/v902/partial';
  await db.sql`insert into remote_worker_leases values(${deadLease},${randomUUID()},'v902','heavy.pipeline','failed',now()-interval '2 hours')`;
  await db.sql`insert into worker_object_uploads values(${randomUUID()},${deadLease},${multipart},'receiving','multipart',now()-interval '2 hours')`;
  const before=objects.size,preview=await pruneCloudMedia(db,storage,false);
  assert(preview.files>0);assert.equal(objects.size,before);assert.equal(removed.length,0);assert.equal(aborted.length,0);
  assert.equal((await db.sql`select * from clips where media_released_at is not null`).length,0);
  const result=await pruneCloudMedia(db,storage);
  for(const key of [published.video,published.poster,privateUpload.video,blocked.video,source,orphan])assert(!objects.has(key),key+' must be removed');
  for(const key of [processing.video,failed.video,rejectedUpload.video,active.video,pending.video,shared.video,neededSource,live,youngOrphan,'clipforge/checks/untouched'])assert(objects.has(key),key+' must survive');
  assert.equal(result.aborted,1);assert.deepEqual(aborted,[multipart]);
  assert.equal((await db.sql`select * from vod_source_assets where vod_id='v900'`).length,0);
  assert.equal((await db.sql`select * from vod_source_assets where vod_id='v901'`).length,1);
  assert.equal((await db.sql`select * from publications where clip_id='published'`).length,1,'history retained');
  assert((await db.sql`select media_released_at from clips where id='published'`)[0].mediaReleasedAt);
  assert.equal((await db.sql`select media_released_at from clips where id='shared'`)[0].mediaReleasedAt,null,'shared object not falsely marked removed');
  // Removing YouTube authorization later must not resurrect released media.
  await db.sql`delete from publications where clip_id='published'`;
  const manifest=await cacheManifest(db,storage);
  assert.equal(manifest.clips.find(c=>c.id==='published').keep,false);
  assert.equal((await pruneCloudMedia(db,storage)).files,0,'cleanup is idempotent');
  // Local published copies do not need a redundant S3 upload before deletion.
  dir=await mkdtemp(join(tmpdir(),'cf-retention-qa-'));
  const out=join(dir,'out'),local=join(out,'dota','sany',published.vod,'published','video.mp4');
  await mkdir(join(local,'..'),{recursive:true});await writeFile(local,'fixture');
  const localResult=await cleanLocalCache(join(dir,'data'),out,{...manifest,generatedAt:new Date(Date.now()+1000).toISOString()},true);
  assert.equal(localResult.files,1);await assert.rejects(stat(local),{code:'ENOENT'});
  // Partial S3 failure preserves the catalog pointer; a later sweep completes.
  const interrupted=await clip('interrupted','published');failKey=interrupted.poster;
  await assert.rejects(pruneCloudMedia(db,storage),/fixture delete failure/);
  assert((await db.sql`select media_storage from clips where id='interrupted'`)[0].mediaStorage);
  failKey=undefined;await pruneCloudMedia(db,storage);
  assert.equal((await db.sql`select media_storage from clips where id='interrupted'`)[0].mediaStorage,null);
  await assert.rejects(storage.removeMedia('clipforge/checks/untouched'));
  console.log('PASS: published/private media released, pending/failed/active/shared copies preserved, unused sources and legacy objects deleted, metadata retained, dry run, local cleanup and interrupted-delete recovery');
}finally{
  await db?.close();
  docker('rm','-f',name);
  if(dir){assert(/^cf-retention-qa-[^\\/]+$/.test(relative(resolve(tmpdir()),resolve(dir))));await rm(dir,{recursive:true,force:true});}
}
