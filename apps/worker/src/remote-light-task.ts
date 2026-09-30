import {readFile} from 'node:fs/promises';
import {listArchives,fetchVodInfo,mainGame} from '@clipforge/pipeline';
import {PAYLOADS,QUEUES} from '@clipforge/jobs';
import {RemoteClient,type Assignment} from './remote-client.js';

async function main(){
  const task=JSON.parse(await readFile(process.argv[2]!,'utf8')) as Assignment,client=await RemoteClient.load();
  if(task.queue!==QUEUES.indexChannel)throw new Error('Задание не относится к каталогу');
  const payload=PAYLOADS[QUEUES.indexChannel].parse(task.payload),login=payload.login.toLowerCase();
  const call=<T>(operation:string,input:unknown={})=>client.request<T>(`tasks/${task.leaseId}/operation`,{operation,input});
  const log=(message:string)=>process.send?.({type:'progress',message});
  const ytdlp={command:process.env.PYTHON_BIN??'/storage/venv/bin/python',args:['-m','yt_dlp','--socket-timeout','20','--retries','2']};
  const known=new Set((await call<{id:string}[]>('catalog.known')).map(v=>v.id));
  log('Поиск новых эфиров');
  const archives=await listArchives(login,payload.limit,ytdlp);let added=0;
  for(const a of archives){
    if(known.has(a.id)&&!payload.withChapters)continue;
    const info=await fetchVodInfo(a.id,ytdlp);
    if(info.login.toLowerCase()!==login)throw new Error('Twitch вернул другой канал');
    const saved=await call<{added:boolean}>('catalog.save',{id:a.id,login,title:info.title||a.title,duration:info.duration||a.duration,
      chapters:info.chapters,publishedAt:info.publishedAt,game:mainGame(info)});
    added+=Number(saved.added);log(`Сведения об эфире ${a.id} сохранены`);
  }
  await call('catalog.finish');process.send?.({type:'result',ok:true,output:{found:archives.length,added}});
}
main().catch(error=>process.send?.({type:'result',ok:false,error:String(error).slice(0,2000)})).finally(()=>process.disconnect?.());
