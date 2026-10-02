/* Runs inside the official Node image. No registry login, env file, database,
 * cloud credentials or inbound port is needed. Only this small launcher is public. */
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {spawn}=require('node:child_process');
const {createWriteStream,createReadStream}=require('node:fs');
const {pipeline}=require('node:stream/promises');
const {Readable}=require('node:stream');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const storage='/storage',identityFile=path.join(storage,'identity.json');
let identity,stage='Подключение',policy,heartbeat;
const run=(command,args,options={})=>new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',windowsHide:true,...options});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Installation step failed')));});
async function api(endpoint,body){const r=await fetch(identity.origin+'/api/worker-gateway/'+endpoint,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+identity.secret,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Platform request failed: '+r.status);return r.json();}
async function download(endpoint,file,limit){const response=await fetch(identity.origin+'/api/worker-gateway/'+endpoint,{headers:{authorization:'Bearer '+identity.secret},redirect:'error',signal:AbortSignal.timeout(1800000)});if(!response.ok||!response.body)throw Error('Worker package unavailable');
  async function* paced(){for await(const bytes of Readable.fromWeb(response.body)){const chunk=Buffer.from(bytes);for(let offset=0;offset<chunk.length;offset+=16384){const piece=chunk.subarray(offset,offset+16384);await sleep(piece.length*1000/limit);yield piece;}}}
  await pipeline(Readable.from(paced()),createWriteStream(file));}
async function main(){
  await fs.mkdir(storage,{recursive:true});
  try{identity=JSON.parse(await fs.readFile(identityFile,'utf8'));}catch{
    const origin=new URL(process.argv[1]).origin,key=process.argv[2];
    if(!/^https?:$/.test(new URL(origin).protocol)||!/^[a-zA-Z0-9_-]{43,128}$/.test(key||''))throw Error('Invalid connection command');
    // Persist before the exchange. A restart after a lost response is idempotent.
    identity={origin,secret:crypto.randomBytes(32).toString('base64url'),key};await fs.writeFile(identityFile,JSON.stringify(identity),{mode:0o600});
  }
  if(!identity.workerId){const registration=await api('enroll',{key:identity.key,secret:identity.secret,host:os.hostname()});identity.workerId=registration.workerId;delete identity.key;await fs.writeFile(identityFile,JSON.stringify(identity),{mode:0o600});}
  heartbeat=setInterval(()=>{api('installation',{stage}).catch(()=>{});},10000);heartbeat.unref();
  const manifest=await api('manifest');policy=manifest.policy;
  const bundle=path.join(storage,'bundle-'+manifest.sha256),marker=path.join(bundle,'.complete');
  if(!await fs.stat(marker).catch(()=>null)){
    stage='Загрузка компонентов';const archive=path.join(storage,'worker-package.tar.gz');await download('bundle',archive,policy.downloadKbps*125);
    const digest=crypto.createHash('sha256');for await(const bytes of createReadStream(archive))digest.update(bytes);
    if(digest.digest('hex')!==manifest.sha256||(await fs.stat(archive)).size!==manifest.size)throw Error('Worker package checksum mismatch');
    await fs.mkdir(bundle,{recursive:true});await run('tar',['-xzf',archive,'-C',bundle]);await fs.writeFile(marker,manifest.sha256);await fs.rm(archive,{force:true});
  }
  stage='Установка компонентов';const catalog=policy.profile==='catalog';
  if((!catalog&&!await fs.stat('/usr/bin/ffmpeg').catch(()=>null))||!await fs.stat('/usr/bin/python3').catch(()=>null)){
    await run('apt-get',['-o','Acquire::http::Dl-Limit='+Math.max(100,Math.floor(policy.downloadKbps/8)),'update']);
    await run('apt-get',['-o','Acquire::http::Dl-Limit='+Math.max(100,Math.floor(policy.downloadKbps/8)),'install','--no-install-recommends','-y','python3','python3-venv','ca-certificates',...(catalog?[]:['ffmpeg','fonts-dejavu-core','libgomp1'])]);
    await run('apt-get',['clean']);
  }
  const venv=path.join(storage,'venv'),python=path.join(venv,'bin','python');
  if(!await fs.stat(python).catch(()=>null))await run('python3',['-m','venv',venv]);
  const requirementFiles={catalog:'requirements-catalog.txt',speech:'requirements-speech.txt',render:'requirements-render.txt',media:'requirements-cpu.txt'};
  const requirements=path.join(bundle,'workers','python',requirementFiles[policy.profile]??requirementFiles.media),reqHash=crypto.createHash('sha256').update(await fs.readFile(requirements)).digest('hex');
  if(await fs.readFile(path.join(venv,'.requirements'),'utf8').catch(()=>'')!==reqHash){
    // pip uses the container's own loopback proxy: one shared download budget,
    // including the initial model/dependency installation.
    await run(python,[path.join(bundle,'scripts','install-worker-deps.py'),requirements,String(policy.downloadKbps)]);
    await fs.writeFile(path.join(venv,'.requirements'),reqHash);
  }
  stage='Подготовка моделей';await fs.mkdir(path.join(storage,'models'),{recursive:true});
  if(!catalog&&policy.profile!=='speech')await run(python,[path.join(bundle,'scripts','setup-media-protection.py'),'--dtln-only','--models',path.join(storage,'models'),'--kibps',String(Math.min(2048,Math.max(16,Math.floor(policy.downloadKbps/8))))]);
  // Runtime is unprivileged. It cannot use the container engine or host paths.
  await run('chown',['-R','1000:1000',storage]);clearInterval(heartbeat);
  const env={...process.env,PATH:path.join(venv,'bin')+':'+process.env.PATH,PYTHON_BIN:python,WORKER_STORAGE:storage,WORKER_IDENTITY_FILE:identityFile,
    MEDIA_BUNDLE_ROOT:bundle,WORKER_ENTRY:path.join(bundle,'remote-agent.mjs'),WORKER_ROLE:'media',WORKER_PROFILE:policy.profile??'media',WORKER_FLEET:'true',RELEASE_SHA:manifest.version,
    MODELS_ROOT:path.join(storage,'models'),HF_HOME:path.join(storage,'models','huggingface'),SPEECH_DEVICE:'cpu',SPEECH_BATCH_SIZE:'1',RENDER_CONCURRENCY:'1',
    MEDIA_OLLAMA_BIN:path.join(bundle,'vision-runtime','bin','ollama'),OLLAMA_MODELS:path.join(storage,'models','ollama'),
    MEDIA_DOWNLOAD_KBPS:String(policy.downloadKbps),MEDIA_UPLOAD_KBPS:String(policy.uploadKbps)};
  const child=spawn(python,[path.join(bundle,'scripts','container-resources.py')],{cwd:bundle,env,stdio:'inherit',uid:1000,gid:1000});
  process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGTERM'));
  child.on('exit',code=>process.exit(code??1));child.on('error',()=>process.exit(1));
}
main().catch(error=>{clearInterval(heartbeat);console.error('ClipForge: '+stage+'. '+String(error.message).replace(/[a-zA-Z0-9_-]{43,}/g,'[redacted]'));process.exit(1);});
