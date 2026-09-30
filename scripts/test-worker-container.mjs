import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const image=process.argv[2];assert(image,'Pass the locally built worker image');
const prefix='cf-worker-test-'+randomUUID().slice(0,8),network=prefix+'-net',database=prefix+'-db';
const names=[prefix+'-a',prefix+'-b'],volumes=names.map(n=>n+'-data');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:180000}).trim();
const dbEnv=['-e','DATABASE_URL=postgres://clipforge:fixture@db:5432/clipforge_workerqa'];
const fixture=mode=>docker('run','--rm','--network',network,...dbEnv,'--entrypoint','node',image,'scripts/worker-container-fixture.mjs',mode);
try{
  docker('network','create',network);
  docker('run','-d','--name',database,'--network',network,'--network-alias','db','--memory','512m','--cpus','1','-e','POSTGRES_USER=clipforge','-e','POSTGRES_PASSWORD=fixture','-e','POSTGRES_DB=clipforge_workerqa','postgres:17-alpine');
  console.log(fixture('schema'));
  for(let i=0;i<2;i++){
    docker('volume','create',volumes[i]);
    // Short synthetic WAVs, no Twitch downloads, speech models or external services.
    docker('run','--rm','--mount',`source=${volumes[i]},target=/storage`,'--entrypoint','python',image,'-c',
      "import wave,pathlib; [(lambda p: (p.mkdir(parents=True,exist_ok=True), (lambda f: (f.setparams((1,2,16000,0,'NONE','not compressed')),f.writeframes(bytes(16000*2*30)),f.close()))(wave.open(str(p/'audio.m4a'),'wb'))))(pathlib.Path('/storage/data/games/unknown/fixture')/('vqa'+str(i))) for i in range(8)]");
    docker('run','-d','--name',names[i],'--network',network,'--init','--cpus','2','--cpu-shares','256','--memory','3g','--memory-swap','3g','--pids-limit','256',
      ...dbEnv,'-e','WORKER_QUEUES=heavy.analyze-vod','-e','S3_ENDPOINT=https://unused.invalid','-e','S3_REGION=test','-e','S3_BUCKET=fixture','-e','S3_ACCESS_KEY_ID=fixture','-e','S3_SECRET_ACCESS_KEY=fixture',
      '--mount',`source=${volumes[i]},target=/storage`,image);
  }
  console.log(fixture('check'));
}catch(error){for(const name of names){try{console.error(docker('logs','--tail','60',name));}catch{}}throw error;}
finally{
  for(const name of [...names,database])try{docker('rm','-f',name);}catch{}
  for(const volume of volumes)try{docker('volume','rm',volume);}catch{}
  try{docker('network','rm',network);}catch{}
}
