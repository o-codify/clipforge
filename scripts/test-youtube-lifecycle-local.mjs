// Run the deployment lifecycle checks without a container build or production DB.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const docker=(...args)=>execFileSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:20000}).trim();
assert.match(docker('context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}'),/^npipe:/);
const name='clipforge_lifecycle_qa_'+randomUUID().replaceAll('-','');
assert.match(name,/^clipforge_lifecycle_qa_[a-f0-9]{32}$/);
const username=docker('exec','clipforge-postgres','printenv','POSTGRES_USER');
const url=new URL('postgres://127.0.0.1:55432/'+name);url.username=username;url.password=docker('exec','clipforge-postgres','printenv','POSTGRES_PASSWORD');
const psql=query=>docker('exec','clipforge-postgres','psql','-U',username,'-d','postgres','-v','ON_ERROR_STOP=1','-c',query);
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const env={...process.env,DATABASE_URL:url.href,WORKER_ROLE:'control',API_PORT:String(port),ADMIN_PASSWORD:'fixture-only-'+randomUUID(),
  CLIPFORGE_ISOLATED_LIFECYCLE:'1',TEST_API_ORIGIN:`http://127.0.0.1:${port}`};
// dotenv does not replace these explicit empty credentials.
for(const key of ['TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET','YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','S3_BUCKET'])env[key]='';
let api,created=false,logs='';
try{
  psql('CREATE DATABASE "'+name+'"');created=true;
  execFileSync(process.execPath,['packages/db/dist/migrate.js'],{cwd:root,env,windowsHide:true,timeout:20000,stdio:['ignore','pipe','pipe']});
  const {default:PgBoss}=await import('../apps/api/node_modules/pg-boss/src/index.js');
  const boss=new PgBoss({connectionString:url.href,schema:'jobs'});boss.on('error',()=>{});
  try{await boss.start();}finally{await boss.stop();}
  api=spawn(process.execPath,['apps/api/dist/main.js'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const stream of [api.stdout,api.stderr])stream.on('data',data=>{logs=(logs+data).slice(-8000);});
  let ready=false;
  for(let i=0;i<60;i++){
    if(api.exitCode!==null)throw new Error('Test API exited: '+logs);
    try{ready=(await fetch(env.TEST_API_ORIGIN+'/api/clips')).status===401;}catch{}
    if(ready)break;
    await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(ready,'Test API did not start: '+logs);
  const result=await promisify(execFile)(process.execPath,['scripts/test-youtube-lifecycle.mjs'],{cwd:root,env,windowsHide:true,timeout:120000,maxBuffer:1024*1024});
  console.log(result.stdout);if(result.stderr)console.error(result.stderr);
}finally{
  if(api&&api.exitCode===null){const exited=new Promise(r=>api.once('exit',r));api.kill();await exited;}
  if(created)psql('DROP DATABASE "'+name+'" WITH (FORCE)');
}
