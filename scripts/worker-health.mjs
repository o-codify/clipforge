import {readFile} from 'node:fs/promises';
try{
  const value=JSON.parse(await readFile(process.env.WORKER_HEARTBEAT_FILE||'/storage/heartbeat.json','utf8'));
  if(value.state!=='online'||Date.now()-value.at>40000)process.exit(1);
}catch{process.exit(1);}
