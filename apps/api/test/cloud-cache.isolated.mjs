// Self-contained: disposable Postgres + MinIO. Never reads production .env.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,stat,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createDatabase} from '../../../packages/db/dist/client.js';
import {upgradeRemoteWorkers} from '../../../packages/db/dist/remote-workers.js';
import {MediaStorage} from '../../../packages/storage/dist/index.js';
import {WorkerObjects} from '../dist/worker-objects.js';
import {archiveWorkspace,restoreSources,sourcePath} from '../../worker/dist/source-cache.js';
import {uploadObject} from '../../worker/dist/object-transfer.js';

const require=createRequire(resolve('packages/storage/package.json'));
const {S3Client,CreateBucketCommand}=require('@aws-sdk/client-s3');
const suffix=randomUUID().slice(0,8),pg='cf-cloud-db-'+suffix,s3='cf-cloud-s3-'+suffix;
const directory=await mkdtemp(join(tmpdir(),'clipforge-cloud-'));
const docker=(...args)=>execFileSync('docker',args,{windowsHide:true,encoding:'utf8',timeout:120000}).trim();
const port=(name,port)=>JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports[port+'/tcp'][0].HostPort;
const wait=async fn=>{for(let i=0;;i++){try{return await fn();}catch(e){if(i>50)throw e;await new Promise(r=>setTimeout(r,200));}}};
let db,client;
try{
  docker('run','-d','--name',pg,'--memory=256m','--cpus=.5','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=fixture','postgres:17-alpine');
  docker('run','-d','--name',s3,'--memory=256m','--cpus=.5','-p','127.0.0.1::9000','-e','MINIO_ROOT_USER=fixture','-e','MINIO_ROOT_PASSWORD=fixture-secret','minio/minio:latest','server','/data');
  db=createDatabase({url:`postgres://postgres:fixture@127.0.0.1:${port(pg,5432)}/postgres`,max:2});
  await wait(()=>db.sql`select 1`);
  await db.sql`create table vods(id text primary key)`;await db.sql`create table worker_instances(id text primary key)`;
  await upgradeRemoteWorkers(db);
  await db.sql`insert into vods values('v100'),('v200')`;await db.sql`insert into worker_instances values('worker-a'),('worker-b')`;
  await db.sql`insert into remote_worker_auth(worker_id,secret_hash,policy) values('worker-a','a','{}'),('worker-b','b','{}')`;
  const lease=randomUUID(),other=randomUUID();
  await db.sql`insert into remote_worker_leases(id,job_id,worker_id,queue,vod_id,payload,expires_at) values
    (${lease},${randomUUID()},'worker-a','heavy.archive-vod','v100','{}',now()+interval '1 hour'),
    (${other},${randomUUID()},'worker-b','heavy.archive-vod','v200','{}',now()+interval '1 hour')`;
  client=new S3Client({endpoint:`http://127.0.0.1:${port(s3,9000)}`,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'fixture',secretAccessKey:'fixture-secret'},requestChecksumCalculation:'WHEN_REQUIRED'});
  await wait(()=>client.send(new CreateBucketCommand({Bucket:'clipforge-fixture'})));
  const storage=new MediaStorage(client,'clipforge-fixture','fixture');
  const objects=new WorkerObjects(db,storage,{leaseId:lease,vodId:'v100',queue:'heavy.archive-vod',payload:{},jobId:randomUUID()});
  const foreign=new WorkerObjects(db,storage,{leaseId:other,vodId:'v200',queue:'heavy.archive-vod',payload:{},jobId:randomUUID()});
  let rejectCompletion=false;
  const request=async(path,body)=>{
    if(path==='objects')return objects.start(body);
    if(path==='sources')return objects.list();
    if(path==='sources/read')return objects.read(body);
    if(path==='operation')return [];
    const [_,id,action]=path.split('/');
    if(action==='part')return objects.part(id,body);
    if(action==='complete'){if(rejectCompletion)throw Error('Fixture connection lost');return objects.complete(id);}
    throw Error('Unexpected request');
  };
  const data=join(directory,'data'),out=join(directory,'out'),root=join(data,'games','game','streamer','v100');
  await mkdir(root,{recursive:true});
  const file=join(root,'video.mp4'),bytes=Buffer.alloc(8*1024*1024+19003,42);await writeFile(file,bytes);
  const info=await stat(file,{bigint:true}),sha256=createHash('sha256').update(bytes).digest('hex');
  for(const name of ['../bad','data/../../bad','/absolute','data/C:/bad','data\\bad'])await assert.rejects(objects.start({name,kind:'cache',size:8,sha256}));
  for(const path of ['../bad','/absolute','C:/bad','a\\b'])assert.throws(()=>sourcePath(root,path));
  rejectCompletion=true;
  await assert.rejects(archiveWorkspace(request,data,out,'v100',0,()=>{}),/connection lost/);
  assert.deepEqual(await readFile(file),bytes,'failed commit must preserve original');
  assert.equal((await objects.list()).length,0,'partial upload is not catalogued');
  rejectCompletion=false;
  const result=await archiveWorkspace(request,data,out,'v100',0,()=>{});
  assert.equal(result.freedBytes,bytes.length);await assert.rejects(stat(file));
  const [asset]=await objects.list();assert.equal(asset.name,'data/video.mp4');assert.equal(asset.sha256,sha256);
  assert.equal((await foreign.list()).length,0);await assert.rejects(foreign.read({name:asset.name,sha256}));
  await restoreSources(request,root,()=>true,0);assert.deepEqual(await readFile(file),bytes);
  assert.equal((await stat(file,{bigint:true})).mtimeNs,info.mtimeNs,'nanosecond timestamps preserve speech/ad cache validity');
  // An interrupted download remains explicitly partial after archive/restore.
  await writeFile(join(root,'video.pending.mp4.part'),'partial');await writeFile(join(root,'video.pending.mp4.ytdl'),'checkpoint');
  await archiveWorkspace(request,data,out,'v100',0,()=>{});await restoreSources(request,root,name=>name.includes('pending'),0);
  assert.equal(await readFile(join(root,'video.pending.mp4.part'),'utf8'),'partial');
  // Clip uploads retain the existing lease-scoped asset proof.
  const clip=join(directory,'clip.mp4');await writeFile(clip,'small-clip');
  await uploadObject(request,clip,{kind:'video',clipId:'v100_clip',name:'v100_clip/video'},0);
  const [proof]=await db.sql`select * from remote_worker_uploads where clip_id='v100_clip'`;
  assert.equal(proof.state,'stored');assert.equal(Number(proof.size),10);
  await assert.rejects(foreign.complete(proof.id));
  // Lost completion response is safe to retry after the object already exists.
  const [stored]=await db.sql`select * from worker_object_uploads where id=${proof.id}`;
  await db.sql`update worker_object_uploads set state='receiving' where id=${proof.id}`;
  await objects.complete(proof.id);assert.equal((await storage.head(stored.storageKey)).ContentLength,10);
  console.log('PASS: real multipart S3, failed commit retains source, checksums, disk cleanup, cross-VOD isolation, nanosecond restore, partial checkpoints, clip proof, idempotent completion');
}finally{
  await db?.close();client?.destroy();
  for(const name of [pg,s3])try{docker('rm','-f','-v',name);}catch{}
  assert(directory.startsWith(join(tmpdir(),'clipforge-cloud-')));await rm(directory,{recursive:true,force:true});
}
