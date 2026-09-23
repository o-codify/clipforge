"use client";
import { Assistant, type AssistantItem, type AssistantMessage, type AssistantReply } from "@clipforge/assistant";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, type ClipRow, type Viewer } from "@/lib/api";
import { useJobs } from "@/lib/jobs";
import { jobNarration } from "@/lib/job-description";
interface Operations { online:boolean; runtime?: Record<string, any>; autoPublishEnabled?:boolean }
interface Summary { clips:number; streamers:number; games:number; published:number; vods:number }
export function PlatformAssistant({ viewer }: { viewer: Viewer }) {
  const router=useRouter();const path=usePathname();const {jobs}=useJobs();
  const [messages,setMessages]=useState<AssistantMessage[]>([]);
  const [operations,setOperations]=useState<Operations|null>(null);
  const [error,setError]=useState(false);
  const signatures=useRef(new Map<string,string>());
  useEffect(()=>{
    let stopped=false;
    const load=async()=>{
      try{
        const [feed,ops]=await Promise.all([api.get<AssistantMessage[]>("/api/jobs/conversation"),api.get<Operations>("/api/operations")]);
        if(stopped)return;setError(false);setOperations(ops);
        const additions:AssistantMessage[]=[];
        const add=(key:string,signature:unknown,text:string,tone:AssistantMessage["tone"]="normal",facts?:AssistantMessage["facts"])=>{
          const value=JSON.stringify(signature);if(signatures.current.get(key)===value)return;signatures.current.set(key,value);
          additions.push({id:`platform-${key}-${Date.now()}`,text,time:new Date().toISOString(),tone,facts});
        };
        add("online",ops.online,ops.online?"Я на связи. Продолжаю следить за эфирами и обрабатывать задания.":"Не вижу процесс обработки. Я покажу сохранённые результаты, но новые клипы пока не создаются.",ops.online?"normal":"error");
        const runtime=ops.runtime;
        if(runtime){
          if(runtime.discovery?.inspected!=null)add("discovery",[runtime.discovery.updatedAt,runtime.discovery.inspected],`Закончил поиск новых стримеров. Проверил ${runtime.discovery.inspected} кандидатов и добавил ${runtime.discovery.added??0}. Приоритет отдаю аудитории, доступным эфирам и подходящему контенту.`);
          if(runtime.scheduler?.reason){
            const reason=String(runtime.scheduler.reason).trim().replace(/[.!?]+$/, "");
            add("scheduler",[runtime.scheduler.reason,runtime.scheduler.vodId],runtime.scheduler.vodId?`Выбрал следующий эфир канала ${runtime.scheduler.streamer}. ${reason}.`:`${reason}. Продолжу автоматически, когда появится возможность.`);
          }
          if(runtime.settings?.paused)add("paused",true,"Вы приостановили новые автоматические задания. Текущую работу завершаю, новые эфиры пока не начинаю.");
          if(runtime.metrics?.state==="error")add("metrics","error","Не смог обновить статистику YouTube. Администратору нужно проверить подключение канала. Создание клипов продолжается.","error");
          if(runtime.metrics?.state==="ok")add("metrics",runtime.metrics.updatedAt,`Обновил статистику публикаций: ${runtime.metrics.collected??0} снимков. Для улучшения отбора учитываю только публичные результаты.`);
        }
        setMessages(previous=>{const merged=new Map(previous.filter(message=>!message.id.startsWith("event-")).map(message=>[message.id,message]));for(const message of [...feed,...additions])merged.set(message.id,{...message,time:merged.get(message.id)?.time??message.time});return [...merged.values()].sort((a,b)=>a.time.localeCompare(b.time)).slice(-300);});
      }catch{if(!stopped)setError(true);}
    };
    setMessages([]);signatures.current.clear();void load();const timer=setInterval(()=>void load(),4000);
    return()=>{stopped=true;clearInterval(timer);};
  },[viewer.accountId,viewer.actingAs]);
  const pending=jobs.filter(job=>["active","created","retry"].includes(job.state));
  const working=pending.find(job=>job.state==="active"&&job.name.startsWith("heavy."))??pending.find(job=>job.state==="active");
  const recentSuccess=jobs.some(job=>job.state==="completed"&&job.completedAt&&Date.now()-new Date(job.completedAt).getTime()<60000);
  const status=error?"Не могу получить свежие сведения. Проверяю связь с сервером.":operations&&!operations.online?"Обработка временно недоступна.":working?jobNarration(working):operations?.runtime?.settings?.paused?"Новые задания на паузе.":pending.length?`Ждут обработки: ${pending.length}.`:"Слежу за платформой. Сейчас активных заданий нет.";
  const items:AssistantItem[]=[{id:"/",label:"Обзор",icon:"⌂"},{id:"/clips",label:"Клипы",icon:"▤"},{id:"/streamers",label:"Стримеры",icon:"◎"},{id:"/games",label:"Игры",icon:"◇"},{id:"/jobs",label:"Задания",icon:"≡"},{id:"/me",label:viewer.isAdmin?"Управление":"Мой профиль",icon:"⚙"},{id:"logout",label:"Выйти",icon:"↪"}];
  const reply=async(text:string):Promise<AssistantReply>=>{
    const q=text.toLocaleLowerCase();
    if(/клип/.test(q)&&!/сколько|статист/.test(q)){
      const clips=await api.get<ClipRow[]>("/api/clips?limit=3&state=ready");
      return {text:clips.length?"Вот последние готовые клипы. Их можно посмотреть прямо здесь.":"Готовых клипов пока нет. Сообщу, когда появятся результаты.",media:clips.map(clip=>({title:`${clip.streamer} · ${Math.round(clip.duration)} сек`,url:`/media/clip/${encodeURIComponent(clip.id)}`,poster:`/media/poster/${encodeURIComponent(clip.id)}`}))};
    }
    if(/результ|статист|сколько|итог/.test(q)){
      const summary=await api.get<Summary>("/api/summary");
      return {text:`Вот текущие результаты. ${summary.published===0?"Подтверждённых публичных публикаций ещё нет — оценивать популярность по ним пока рано.":"Публичные результаты используются для уточнения приоритетов."}`,facts:[{label:"Клипов",value:String(summary.clips)},{label:"Стримеров",value:String(summary.streamers)},{label:"Эфиров",value:String(summary.vods)},{label:"Публичных",value:String(summary.published)}],actions:[{id:"show-clips",label:"Показать клипы в чате"}]};
    }
    if(/почему|приоритет|выбра|анализ/.test(q)){
      const ops=await api.get<Operations>("/api/operations");const scheduler=ops.runtime?.scheduler;
      return {text:scheduler?`${scheduler.streamer?`Выбран канал ${scheduler.streamer}. `:""}${scheduler.reason??"Сравниваю доступные эфиры"}. Учитываю текущую аудиторию, подписчиков и публичные результаты клипов. Каждый пятый успешный прогон пробую менее обработанный канал. Затем сравниваю речь, звук и разнообразие моментов.`:"В вашем доступе видны только связанные с вами материалы. Для клипов сравниваю речь, звуковую активность и разнообразие моментов.",facts:scheduler?[{label:"Бюджет эфиров/сутки",value:String(scheduler.dailyLimit??3)},{label:"Лимит загрузки",value:"40 000 Кбит/с"}]:undefined};
    }
    if(/youtube|ютуб|публик/.test(q)){
      const ops=await api.get<Operations>("/api/operations");
      const failed=ops.runtime?.metrics?.state==="error"||ops.runtime?.["youtube-access"]?.state==="error";
      return {text:failed?"Не удалось обновить данные YouTube. Нужно проверить подключение канала; готовые клипы продолжаю сохранять.":`Я различаю загруженные, приватные и действительно публичные ролики. ${ops.autoPublishEnabled?"Автопубликация включена; фактическую видимость проверяю после загрузки.":"Автопубликация сейчас выключена."}`,actions:viewer.isAdmin?[{id:"/me",label:"Проверить подключение"}]:undefined};
    }
    const match=items.find(item=>q.includes(item.label.toLocaleLowerCase()));
    if(match)return {text:`Раздел «${match.label}» доступен здесь.`,actions:[{id:match.id,label:`Открыть: ${match.label}`}]};
    if(/дела|происход|работ|статус|сейчас/.test(q))return {text:status, facts:[{label:"Выполняется",value:String(pending.filter(job=>job.state==="active").length)},{label:"В очереди",value:String(pending.filter(job=>job.state!=="active").length)}]};
    return {text:"Могу рассказать, что делаю сейчас, показать результаты, объяснить выбор эфира или состояние публикаций. Сообщения ниже приходят от реальных этапов обработки; новые результаты появятся здесь автоматически."};
  };
  return <Assistant key={`${viewer.accountId}:${viewer.actingAs??"all"}`} historyKey={`clipforge-chat:${viewer.accountId}:${viewer.actingAs??"all"}`} name="ClipForge" identity={viewer.isAdmin?"Администратор":viewer.role==="moderator"?"Модератор":viewer.displayName} items={items} currentItem={items.find(item=>item.id!=="/"&&path.startsWith(item.id))?.id??"/"}
    status={status} pending={pending.length} mood={error||operations&&!operations.online?"error":working?"working":operations?.runtime?.settings?.paused?"paused":recentSuccess?"success":"idle"} messages={messages} onMessage={reply}
    onSelect={async id=>{
      if(id==="show-clips"||id.startsWith("clips:")){
        if(id!=="show-clips"&&!messages.some(message=>message.actions?.some(action=>action.id===id)))throw new Error("Неизвестное действие");
        const clips=await api.get<ClipRow[]>(`/api/clips?limit=3&state=ready${id.startsWith("clips:")?`&vod=${encodeURIComponent(id.slice(6))}`:""}`);
        setMessages(old=>[...old,{id:`preview-${Date.now()}`,time:new Date().toISOString(),text:clips.length?"Вот готовые клипы. Можно смотреть прямо в чате.":"Для этого эфира пока нет готовых клипов.",media:clips.map(clip=>({title:`${clip.streamer} · ${Math.round(clip.duration)} сек`,url:`/media/clip/${encodeURIComponent(clip.id)}`,poster:`/media/poster/${encodeURIComponent(clip.id)}`}))}]);return;
      }
      const allowed=items.some(item=>item.id===id)||messages.some(message=>message.actions?.some(action=>action.id===id));
      if(!allowed)throw new Error("Неизвестное действие");
      if(id==="logout"){sessionStorage.removeItem(`clipforge-chat:${viewer.accountId}:${viewer.actingAs??"all"}`);await api.post("/api/auth/logout");window.location.href="/login";}else router.push(id);
    }}/>
}
