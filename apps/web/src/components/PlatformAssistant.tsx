"use client";
import { StreamerBadge } from "./StreamerBadge";
import { Assistant, type AssistantItem, type AssistantMessage, type AssistantReply } from "@clipforge/assistant";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, type ClipRow, type Viewer } from "@/lib/api";
import { useJobs } from "@/lib/jobs";
import { jobNarration } from "@/lib/job-description";
import { workspaceLinks } from "@/lib/navigation";
interface Operations { online:boolean; runtime?: Record<string, any>; autoPublishEnabled?:boolean }
interface Summary { clips:number; streamers:number; games:number; published:number; vods:number }
function selectionMessage(ops:Operations){
  if(ops.runtime?.settings?.paused)return "Пока не выбираю новые эфиры: обработка на паузе.";
  if(ops.runtime?.settings?.developmentMode)return "Автоматическая нарезка выключена. Обработаю эфир, когда вы запустите задание.";
  if(!ops.online)return "Сейчас не обрабатываю эфиры. Покажу уже готовые материалы.";
  const streamer=ops.runtime?.scheduler?.streamer;
  return streamer?"Выбрал эфир для обработки. Учитываю доступность записи, аудиторию и то, какие каналы уже обрабатывал.":"Проверяю доступные эфиры, прежде чем выбрать следующий.";
}
export function PlatformAssistant({ viewer }: { viewer: Viewer }) {
  const router=useRouter();const {jobs}=useJobs();
  const [messages,setMessages]=useState<AssistantMessage[]>([]);
  const [operations,setOperations]=useState<Operations|null>(null);
  const [error,setError]=useState(false);
  const signatures=useRef(new Map<string,string>());
  const hasActive=useRef(false);
  hasActive.current=jobs.some(job=>["active","created","retry"].includes(job.state));
  useEffect(()=>{
    let stopped=false;
    let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try{
        const [feed,ops]=await Promise.all([api.get<AssistantMessage[]>("/api/jobs/conversation"),api.get<Operations>("/api/operations")]);
        if(stopped)return;setError(false);setOperations(ops);
        const additions:AssistantMessage[]=[];
        const add=(key:string,signature:unknown,text:string,tone:AssistantMessage["tone"]="normal",facts?:AssistantMessage["facts"],streamer?:string)=>{
          const value=JSON.stringify(signature);if(signatures.current.get(key)===value)return;signatures.current.set(key,value);
          additions.push({id:`platform-${key}-${Date.now()}`,text,time:new Date().toISOString(),tone,facts,streamer});
        };
        add("online",ops.online,ops.online?"Я на связи. Покажу, как идут задания и какие результаты уже готовы.":"Сейчас не обрабатываю эфиры. Покажу уже готовые материалы.",ops.online?"normal":"error");
        const runtime=ops.runtime;
        if(runtime){
          if(runtime.discovery?.inspected!=null)add("discovery",[runtime.discovery.updatedAt,runtime.discovery.inspected],`Закончил поиск новых стримеров. Проверил ${runtime.discovery.inspected} кандидатов и добавил ${runtime.discovery.added??0}. Приоритет отдаю аудитории, доступным эфирам и подходящему контенту.`);
          if(runtime.scheduler)add("scheduler",[runtime.scheduler.vodId,runtime.settings?.developmentMode,runtime.settings?.paused],selectionMessage(ops),"normal",undefined,runtime.scheduler.streamer);
          if(runtime.settings?.paused)add("paused",true,"Вы приостановили новые автоматические задания. Текущую работу завершаю, новые эфиры пока не начинаю.");
          if(runtime.metrics?.state==="error")add("metrics","error","Не смог обновить статистику YouTube. Администратору нужно проверить подключение канала. Создание клипов продолжается.","error");
          if(runtime.metrics?.state==="ok")add("metrics",runtime.metrics.updatedAt,`Обновил статистику публикаций: ${runtime.metrics.collected??0} видео. Сохранил просмотры и реакции, полученные от YouTube.`);
        }
        setMessages(previous=>{const merged=new Map(previous.filter(message=>!message.id.startsWith("event-")).map(message=>[message.id,message]));for(const message of [...feed,...additions])merged.set(message.id,{...message,time:merged.get(message.id)?.time??message.time});return [...merged.values()].sort((a,b)=>a.time.localeCompare(b.time)).slice(-300);});
      }catch{if(!stopped)setError(true);}finally{if(!stopped)timer=setTimeout(load,hasActive.current?8000:30000);}
    };
    setMessages([]);signatures.current.clear();void load();
    return()=>{stopped=true;clearTimeout(timer);};
  },[viewer.accountId,viewer.actingAs]);
  const pending=jobs.filter(job=>["active","created","retry"].includes(job.state));
  const working=pending.find(job=>job.state==="active"&&job.name.startsWith("heavy."))??pending.find(job=>job.state==="active");
  const recentSuccess=jobs.some(job=>job.state==="completed"&&job.completedAt&&Date.now()-new Date(job.completedAt).getTime()<60000);
  const status=error?"Не могу получить свежие сведения. Проверяю связь с сервером.":operations&&!operations.online?"Обработка временно недоступна.":working?jobNarration(working):operations?.runtime?.settings?.paused?"Новые задания на паузе.":pending.length?`Ждут обработки: ${pending.length}.`:"Слежу за платформой. Сейчас активных заданий нет.";
  const items:AssistantItem[]=workspaceLinks(viewer).map(item=>({id:item.href,label:item.label}));
  const reply=async(text:string):Promise<AssistantReply>=>{
    const q=text.toLocaleLowerCase();
    if(/клип/.test(q)&&!/сколько|статист/.test(q)){
      const clips=await api.get<ClipRow[]>("/api/clips?limit=3&state=ready");
      return {text:clips.length?"Вот последние готовые клипы. Их можно посмотреть прямо здесь.":"Готовых клипов пока нет. Сообщу, когда появятся результаты.",media:clips.map(clip=>({streamer:clip.streamer,title:`${Math.round(clip.duration)} сек`,url:`/media/clip/${encodeURIComponent(clip.id)}`,poster:`/media/poster/${encodeURIComponent(clip.id)}`}))};
    }
    if(/результ|статист|сколько|итог/.test(q)){
      const summary=await api.get<Summary>("/api/summary");
      return {text:"Собрал текущие результаты.",facts:[{label:"Клипов",value:String(summary.clips)},...(viewer.role!=="user"?[{label:"Стримеров",value:String(summary.streamers)}]:[]),{label:"Эфиров",value:String(summary.vods)},{label:"Публичных",value:String(summary.published)}],actions:[{id:"show-clips",label:"Показать клипы в чате"}]};
    }
    if(/почему|приоритет|выбра|анализ/.test(q)){
      const ops=await api.get<Operations>("/api/operations");const scheduler=ops.runtime?.scheduler;
      return {streamer:scheduler?.streamer,text:scheduler?selectionMessage(ops):"Для отбора моментов сравниваю речь, звуковую активность и разнообразие фрагментов вашего эфира."};
    }
    if(/youtube|ютуб|публик/.test(q)){
      if(!viewer.isAdmin){
        const summary=await api.get<Summary>("/api/summary");
        return {text:summary.published?`Опубликовано клипов: ${summary.published}. Ссылки доступны в карточках клипов.`:"Публичных публикаций пока нет. Готовые клипы можно посмотреть здесь.",actions:[{id:"show-clips",label:"Показать клипы"}]};
      }
      const ops=await api.get<Operations>("/api/operations");
      const failed=ops.runtime?.metrics?.state==="error"||ops.runtime?.["youtube-access"]?.state==="error";
      return {text:failed?"Не удалось обновить данные YouTube. Нужно проверить подключение канала; готовые клипы продолжаю сохранять.":`Я различаю загруженные, приватные и действительно публичные ролики. ${ops.autoPublishEnabled?"Автопубликация включена; фактическую видимость проверяю после загрузки.":"Автопубликация сейчас выключена."}`,actions:viewer.isAdmin?[{id:"/settings/publication",label:"Проверить подключение"}]:undefined};
    }
    const match=items.find(item=>q.includes(item.label.toLocaleLowerCase()));
    if(match)return {text:`Раздел «${match.label}» доступен здесь.`,actions:[{id:match.id,label:`Открыть: ${match.label}`}]};
    if(/дела|происход|работ|статус|сейчас/.test(q))return {text:status, facts:[{label:"Выполняется",value:String(pending.filter(job=>job.state==="active").length)},{label:"В очереди",value:String(pending.filter(job=>job.state!=="active").length)}]};
    return {text:"Могу рассказать, что делаю сейчас, показать результаты, объяснить выбор эфира или состояние публикаций. Сообщения ниже приходят от реальных этапов обработки; новые результаты появятся здесь автоматически."};
  };
  return <Assistant key={`${viewer.accountId}:${viewer.actingAs??"all"}`} historyKey={`clipforge-chat:${viewer.accountId}:${viewer.actingAs??"all"}`} name="ClipForge" renderStreamer={login=><StreamerBadge login={login}/>}
    status={status} pending={pending.length} mood={error||operations&&!operations.online?"error":working?"working":operations?.runtime?.settings?.paused?"paused":recentSuccess?"success":"idle"} messages={messages} onMessage={reply}
    onSelect={async id=>{
      if(id==="show-clips"||id.startsWith("clips:")){
        if(id!=="show-clips"&&!messages.some(message=>message.actions?.some(action=>action.id===id)))throw new Error("Неизвестное действие");
        const clips=await api.get<ClipRow[]>(`/api/clips?limit=3&state=ready${id.startsWith("clips:")?`&vod=${encodeURIComponent(id.slice(6))}`:""}`);
        setMessages(old=>[...old,{id:`preview-${Date.now()}`,time:new Date().toISOString(),text:clips.length?"Вот готовые клипы. Можно смотреть прямо в чате.":"Для этого эфира пока нет готовых клипов.",media:clips.map(clip=>({streamer:clip.streamer,title:`${Math.round(clip.duration)} сек`,url:`/media/clip/${encodeURIComponent(clip.id)}`,poster:`/media/poster/${encodeURIComponent(clip.id)}`}))}]);return;
      }
      const allowed=items.some(item=>item.id===id)||messages.some(message=>message.actions?.some(action=>action.id===id));
      if(!allowed)throw new Error("Неизвестное действие");
      router.push(id);
    }}/>
}
