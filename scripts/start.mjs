import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { mkdirSync, createWriteStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
process.chdir(root);
for (const port of [3000,8420]) {
  const occupied=await new Promise(resolve=>{
    const socket=createConnection({host:"127.0.0.1",port});
    socket.once("connect",()=>{socket.destroy();resolve(true);});
    socket.once("error",()=>resolve(false));
    socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});
  });
  if(occupied){console.error(`Порт ${port} уже занят. Если ClipForge работает, откройте http://localhost:3000. Второй экземпляр не запущен.`);process.exit(1);}
}
const lock=createServer();
lock.on("error",()=>{console.error("Платформа уже запущена (порт управления 18421 занят).");process.exit(1);});
await new Promise(r=>lock.listen(18421,"127.0.0.1",r));
const run=(cmd,args)=>new Promise((resolve,reject)=>{
  const p=spawn(cmd,args,{stdio:"inherit",windowsHide:true,shell:process.platform==="win32" && cmd.endsWith(".cmd")});
  p.on("error",reject);p.on("exit",code=>code===0?resolve():reject(new Error(`${cmd}: ${code}`)));
});
await run("docker",["compose","up","-d","--wait","postgres"]);
const pnpm=process.platform==="win32"?"pnpm.cmd":"pnpm";
await run(pnpm,["exec","turbo","run","build","--filter=!@clipforge/web"]);
mkdirSync("data/logs",{recursive:true});
let stopped=false;
const children=new Set();
function supervise(name,args,cwd=root){
  if(stopped)return;
  const log=createWriteStream(`data/logs/${name}.log`,{flags:"a"});
  const child=spawn(process.execPath,args,{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  children.add(child);child.stdout.pipe(log);child.stderr.pipe(log);
  child.on("error",error=>console.error(`${name}: ${error.message}`));
  child.on("exit",code=>{children.delete(child);log.end();if(!stopped){console.log(`${name} остановился (${code}), перезапуск через 10 секунд`);setTimeout(()=>supervise(name,args,cwd),10000);}});
}
supervise("api",["apps/api/dist/main.js"]);
supervise("worker",["apps/worker/dist/main.js"]);
supervise("web",[resolve("apps/web/node_modules/next/dist/bin/next"),"dev","-p","3000"],resolve("apps/web"));
console.log("ClipForge: http://localhost:3000 — журналы data/logs. Ctrl+C завершает запуск.");
async function stop(){if(stopped)return;stopped=true;for(const child of children) child.kill("SIGTERM");lock.close();}
process.on("SIGINT",stop);process.on("SIGTERM",stop);
