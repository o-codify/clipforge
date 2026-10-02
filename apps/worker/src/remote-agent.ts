import {fork,type ChildProcess} from 'node:child_process';
import {mkdir,writeFile,rename,statfs,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {capacity} from './registry.js';
import {resourceState} from '@clipforge/resources';
import {RemoteClient,type Assignment} from './remote-client.js';
import {cachedVods} from './source-cache.js';

async function main(){
  const client=await RemoteClient.load(),storage=process.env.WORKER_STORAGE??'/storage',root=process.env.MEDIA_BUNDLE_ROOT??process.cwd();
  await mkdir(join(storage,'tasks'),{recursive:true});
  let active:Assignment|null=null,child:ChildProcess|null=null,stopping=false,lastContact=0,busy=false;
  let cacheReportedAt=0;
  const messages:string[]=[];let result:{ok:boolean;output?:Record<string,unknown>;error?:string}|null=null;
  const stopTask=()=>{if(child?.pid){try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{} } child=null;active=null;result=null;messages.length=0;};
  const beat=async()=>{if(busy)return;busy=true;try{
    const allocation=await capacity(),disk=await statfs(storage),state=resourceState();
    const response=await client.request<{accepted:boolean;draining:boolean;upgradeRequired:boolean}>('heartbeat',{leaseId:active?.leaseId??null,version:process.env.RELEASE_SHA??'local',
      resources:{allocation,freeGb:Number(disk.bavail)*Number(disk.bsize)/1024**3,paused:state.paused,reason:state.reason??null,
        memoryMb:state.memoryMb,cpuPercent:state.cpuPercent,metrics:state.metrics,downloadKbps:state.downloadKbps,uploadKbps:state.uploadKbps}},7000);
    lastContact=Date.now();
    if(active&&!response.accepted)stopTask();
    if(!active&&response.upgradeRequired)stopping=true;
    const heartbeat=join(storage,'heartbeat.json');await writeFile(heartbeat+'.tmp',JSON.stringify({at:Date.now(),workerId:client.identity.workerId,leaseId:active?.leaseId??null}));await rename(heartbeat+'.tmp',heartbeat);
    if(active&&messages.length){const batch=messages.splice(0,30);await client.request(`tasks/${active.leaseId}/progress`,{messages:batch},7000);}
  }catch(error){if((error as {permanent?:boolean}).permanent){stopTask();stopping=true;} }
  finally{busy=false;}};
  const timer=setInterval(()=>{void beat();if(active&&Date.now()-lastContact>45000)stopTask();},5000);
  process.on('SIGTERM',()=>{stopping=true;stopTask();});process.on('SIGINT',()=>{stopping=true;stopTask();});
  try{await beat();while(!stopping){
    if(active&&result){const done=result,leaseId=active.leaseId;try{await client.request(`tasks/${leaseId}/finish`,done);await rm(join(storage,'tasks',leaseId+'.json'),{force:true});stopTask();}
      catch(error){if((error as {permanent?:boolean}).permanent)stopTask();}}
    if(!active&&Date.now()-lastContact<15000){try{
      if(Date.now()-cacheReportedAt>300000){const vodIds=await cachedVods(join(storage,'data'),join(storage,'out'));
        if(process.env.WORKER_LEGACY_DATA&&process.env.WORKER_LEGACY_OUT)vodIds.push(...await cachedVods(process.env.WORKER_LEGACY_DATA,process.env.WORKER_LEGACY_OUT));
        await client.request('cache',{vodIds:[...new Set(vodIds)]});cacheReportedAt=Date.now();}
      const task=await client.request<Assignment|null>('next',{});if(task){active=task;result=null;lastContact=Date.now();
        const file=join(storage,'tasks',task.leaseId+'.json');await writeFile(file,JSON.stringify(task),{mode:0o600});
        child=fork(join(root,task.queue==='light.index-channel'?'remote-light-task.mjs':'remote-task.mjs'),[file],{cwd:root,detached:process.platform!=='win32',...{windowsHide:true},stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,WORKER_FLEET:'true',WORKER_ROLE:'media'}});
        child.on('message',(value:unknown)=>{const m=value as {type:string;message?:string;ok:boolean;output?:Record<string,unknown>;error?:string};if(active?.leaseId!==task.leaseId)return;
          if(m.type==='progress'&&m.message){messages.push(m.message.slice(0,500));if(messages.length>30)messages.shift();}
          if(m.type==='result')result={ok:m.ok,output:m.output??{},...(m.error?{error:m.error}:{})};});
        child.on('error',()=>{result={ok:false,error:'Не удалось запустить обработку'};});
        child.on('exit',()=>{if(active?.leaseId===task.leaseId&&!result)result={ok:false,error:'Процесс обработки остановился; готовые результаты сохранены'};});
      }
    }catch(error){if((error as {permanent?:boolean}).permanent)stopping=true;}}
    await delay(2000);
  }}finally{clearInterval(timer);stopTask();}
}
main().catch(()=>{console.error('Воркер остановлен: связь с платформой недоступна');process.exit(1);});
