"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Mascot } from "./Mascot";


export interface AssistantItem { id: string; label: string; icon?: string }
export interface AssistantMessage {
  id: string; text: string; time: string; role?: "assistant" | "user";
  steps?: {label:string;state:string}[];
  streamer?: string; context?: string; facts?: {label:string; value:string}[];
  actions?: {id:string; label:string}[];
  media?: {title:string; url:string; poster?:string; streamer?:string}[];
  technical?: string; tone?: "normal" | "error" | "success";
}
export interface AssistantReply { streamer?:string; media?: AssistantMessage["media"]; text: string; facts?: AssistantMessage["facts"]; actions?: AssistantMessage["actions"] }
export interface AssistantProps {
  historyKey?: string;
  renderStreamer?: (login:string)=>ReactNode;
  renderMedia?: (media:NonNullable<AssistantMessage['media']>[number])=>ReactNode;
  name: string; identity?: string; status: string; pending: number;
  mood: "idle" | "working" | "success" | "error" | "paused";
  messages: AssistantMessage[];
  onSelect: (id:string) => void | Promise<void>;
  /** The host resolves messages and validates actions. Models may only suggest allowlisted actions. */
  onMessage: (text:string) => Promise<AssistantReply>;
}

export function Assistant({historyKey,name,status,pending,mood,messages,onSelect,onMessage,renderStreamer,renderMedia}:AssistantProps) {
  const [open,setOpen]=useState(false);
  const [query,setQuery]=useState("");
  const [conversation,setConversation]=useState<AssistantMessage[]>([]);
  const [historyLoaded,setHistoryLoaded]=useState(false);
  const [sending,setSending]=useState(false);
  const [actionError,setActionError]=useState("");
  const [unread,setUnread]=useState(false);
  const root=useRef<HTMLDivElement>(null);
  const launcher=useRef<HTMLButtonElement>(null);
  const input=useRef<HTMLInputElement>(null);
  const chat=useRef<HTMLDivElement>(null);
  const follow=useRef(true);
  const id=useId();
  const all=[...messages,...conversation].map(message=>message.streamer?{...message,
    actions:message.actions?.filter(action=>action.id!==`/streamers/${encodeURIComponent(message.streamer!)}`),
  }:message).sort((a,b)=>a.time.localeCompare(b.time)||a.id.localeCompare(b.id));
  const last=all.at(-1)?.id;
  useEffect(()=>{
    try { const saved=historyKey?sessionStorage.getItem(historyKey):null; if(saved){const parsed=JSON.parse(saved);if(Array.isArray(parsed))setConversation(parsed.filter(m=>typeof m?.id==="string"&&typeof m?.text==="string"&&typeof m?.time==="string").slice(-60));} }catch{}
    setHistoryLoaded(true);
  },[historyKey]);
  useEffect(()=>{if(historyLoaded&&historyKey){try{sessionStorage.setItem(historyKey,JSON.stringify(conversation.slice(-60)));}catch{}}},[conversation,historyKey,historyLoaded]);
  useEffect(()=>{
    if (!open) return;
    input.current?.focus();
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){setOpen(false);launcher.current?.focus();}};
    document.addEventListener("keydown",key);
    return()=>{document.removeEventListener("keydown",key);};
  },[open]);
  useEffect(()=>{
    if(open && follow.current && chat.current){chat.current.scrollTop=chat.current.scrollHeight;setUnread(false);}
    else if(last)setUnread(true);
  },[last,open]);
  const select=async(itemId:string,close:boolean)=>{
    try{setActionError("");await onSelect(itemId);if(close)setOpen(false);}
    catch{setActionError("Не получилось выполнить действие. Попробуйте ещё раз.");}
  };
  const submit=async(text=query)=>{
    if(!text.trim()||sending)return;
    const prefix=`conversation-${Date.now()}`;
    setConversation(old=>[...old,{id:prefix,text,time:new Date().toISOString(),role:"user"}]);
    setQuery("");setSending(true);follow.current=true;
    try{const reply=await onMessage(text);setConversation(old=>[...old,{id:`${prefix}-reply`,...reply,time:new Date().toISOString()}]);}
    catch{setConversation(old=>[...old,{id:`${prefix}-error`,text:"Не могу получить свежие данные. Попробуйте ещё раз — я не буду выдавать старые сведения за актуальные.",time:new Date().toISOString(),tone:"error"}]);}
    finally{setSending(false);input.current?.focus();}
  };
  return <div className={`cfa cfa-${mood}`} ref={root}>
    {open&&<section className="cfa-panel" role="dialog" aria-label={`Помощник ${name}`} id={id}>
      <div className="cfa-conversation"><div className="cfa-chat-heading"><div><strong>Разговор с {name}</strong><small>Что происходит, почему и что получилось</small></div><button aria-label="Закрыть помощника" onClick={()=>{setOpen(false);launcher.current?.focus();}}>×</button></div>
        <div className="cfa-current" role="status">{status}</div>
        <div ref={chat} className="cfa-chat" role="log" aria-label="Чат с платформой" aria-live="polite" onScroll={()=>{const el=chat.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<70;}}>
          <div className="cfa-welcome"><strong>Я здесь, чтобы держать вас в курсе.</strong><p>Рассказываю, что ищу, что анализирую и какие клипы получаются. Спросите о результатах или о том, почему я выбрал эфир.</p></div>
          {all.map(message=><article key={message.id} className={`cfa-message ${message.role==="user"?"cfa-user":""} ${message.tone??"normal"}`}><div className="cfa-message-by">{message.role==="user"?"Вы":name}<time>{new Date(message.time).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}</time></div><p>{message.text}</p>{message.streamer&&<div className="cfa-streamer">{renderStreamer?.(message.streamer)}</div>}{message.context&&<div className="cfa-context">{message.context}</div>}{message.steps?.length ? <ol className="cfa-steps" aria-label="Этапы обработки">{message.steps.map(step=><li key={step.label} data-state={step.state}>{step.state==="done"?"✓ ":""}{step.label}</li>)}</ol>:null}{message.facts&&<dl>{message.facts.map(fact=><div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}{message.media&&<div className="cfa-media">{message.media.map(video=><figure key={video.url}>{renderMedia?renderMedia(video):<video controls preload="none" src={video.url} poster={video.poster}/>}<figcaption>{video.streamer&&renderStreamer?.(video.streamer)}<span>{video.title}</span></figcaption></figure>)}</div>}{!!message.actions?.length&&<div className="cfa-actions">{message.actions.map(action=><button key={action.id} onClick={()=>void select(action.id,false)}>{action.label}</button>)}</div>}</article>)}
          {sending&&<p className="cfa-thinking">Смотрю данные…</p>}
        </div>
        {unread&&<button className="cfa-unread" onClick={()=>{follow.current=true;setUnread(false);if(chat.current)chat.current.scrollTop=chat.current.scrollHeight;}}>Новые сообщения ↓</button>}
        {actionError&&<p className="cfa-error" role="alert">{actionError}</p>}
        <div className="cfa-suggestions">{["Что сейчас делаешь?","Какие результаты?","Почему этот эфир?"].map(text=><button key={text} disabled={sending} onClick={()=>void submit(text)}>{text}</button>)}</div>
        <form onSubmit={event=>{event.preventDefault();void submit();}}><input ref={input} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Спросите о работе платформы…" aria-label="Сообщение помощнику"/><button disabled={sending||!query.trim()} aria-label="Отправить сообщение">↑</button></form>
      </div>
    </section>}
    <button ref={launcher} className="cfa-launcher" aria-label={`Открыть помощника ${name}`} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}><Mascot size={52} mood={sending?"working":mood}/>{pending>0&&<span className="cfa-badge">{pending}</span>}{!open&&unread&&<span className="cfa-notice"/>}</button>
  </div>;
}

