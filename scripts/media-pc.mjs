import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseEnv } from 'node:util';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { resolve, join } from 'node:path';

const home=resolve(process.argv[2] || process.env.CLIPFORGE_MEDIA_HOME || '.media-runtime');
const config=parseEnv(await readFile(join(home,'.env'),'utf8'));
const exec=promisify(execFile);
const ssh=process.platform==='win32'?'C:/Windows/System32/OpenSSH/ssh.exe':'ssh';
const sshArgs=['-F',config.SSH_CONFIG,'-o','BatchMode=yes','-o','ConnectTimeout=15'];
if(!/^[a-zA-Z0-9_-]+$/.test(config.POSTGRES_CONTAINER))throw Error('Invalid PostgreSQL container name');
const port=Number(config.TUNNEL_PORT || 55433);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid tunnel port');
await mkdir(join(home,'logs'),{recursive:true});
const log=message=>void appendFile(join(home,'logs',`media-${new Date().toISOString().slice(0,10)}.log`),`${new Date().toISOString()} ${message}\n`);
const guard=createServer();
await new Promise((ok,fail)=>{guard.once('error',fail);guard.listen(18423,'127.0.0.1',ok);});
let stopping=false;
let updating=false;
async function updateRuntime(){
 if(updating||stopping||process.platform!=='win32')return;
 updating=true;
 try{await exec('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',join(home,'update-media.ps1'),'-RuntimeHome',home],{windowsHide:true,timeout:180000});}
 catch{log('Prepared runtime update unavailable; will retry');}
 finally{updating=false;}
}
const updateTimer=setInterval(()=>void updateRuntime(),5*60_000);
void updateRuntime();
let wakeStop;
const stopRequested=new Promise(resolveStop=>{wakeStop=resolveStop;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;wakeStop();});
process.on('message',message=>{if(message==='shutdown'){stopping=true;wakeStop();}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function exited(child){return new Promise(r=>{child.once('exit',r);child.once('error',r);});}
async function terminate(child){
 if(!child?.pid)return;
 const done=exited(child);
 if(child.exitCode===null&&child.signalCode===null){
  if(child.connected)child.send('shutdown');else child.kill();
  await Promise.race([done,sleep(40000)]);
 }
 // Python/ffmpeg must never be orphaned, including after an abrupt Node exit.
 if(process.platform==='win32')await exec('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
 else {try{process.kill(-child.pid,'SIGKILL');}catch{}}
}
async function portReady(){
 for(let i=0;i<30;i++){
  if(stopping)return false;
  if(await new Promise(ok=>{const s=createConnection({host:'127.0.0.1',port});s.setTimeout(500);s.once('connect',()=>{s.destroy();ok(true);});s.once('error',()=>ok(false));s.once('timeout',()=>{s.destroy();ok(false);});}))return true;
  await sleep(500);
 }
 return false;
}
while(!stopping){
 let tunnel,worker,watch;
 try{
  const current=JSON.parse(await readFile(join(home,'current.json'),'utf8'));
  const {stdout}=await exec(ssh,[...sshArgs,config.SSH_HOST,`docker inspect ${config.POSTGRES_CONTAINER} --format '{{(index .NetworkSettings.Networks "coolify").IPAddress}}'`],{windowsHide:true,timeout:20000});
  const ip=stdout.trim();if(!/^\d+\.\d+\.\d+\.\d+$/.test(ip))throw Error('Database network address unavailable');
  tunnel=spawn(ssh,[...sshArgs,'-N','-T','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-L',`127.0.0.1:${port}:${ip}:5432`,config.SSH_HOST],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  const tunnelExit=exited(tunnel);tunnel.stderr.on('data',buf=>log(`SSH: ${buf.toString().trim()}`));
  if(!await portReady())throw Error('Database tunnel did not become ready');
  worker=spawn(process.execPath,[current.entry || 'apps/worker/dist/main.js'],{cwd:current.path,env:{...process.env,...config,WORKER_ROLE:'media'},windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc']});
  worker.stdout.on('data',buf=>log(buf.toString().trim()));worker.stderr.on('data',buf=>log(buf.toString().trim()));
  log(`Media worker started, release ${current.release}`);
  const update=new Promise(resolveUpdate=>{watch=setInterval(async()=>{
   try{const next=JSON.parse(await readFile(join(home,'current.json'),'utf8'));if(next.release!==current.release)resolveUpdate();}catch{log('Could not inspect pending worker release');}
  },15000);});
  await Promise.race([exited(worker),tunnelExit,update,stopRequested]);
 }catch(error){log(`Supervisor: ${error.message}`);}
 finally{clearInterval(watch);await terminate(worker);await terminate(tunnel);}
 if(!stopping)await Promise.race([sleep(10000),stopRequested]);
}
guard.close();
clearInterval(updateTimer);
log('Media supervisor stopped');
