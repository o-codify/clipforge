"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/session";
import { api, when, type JobGroup, type JobRow } from "@/lib/api";
import { jobAction } from "@/lib/job-description";
import { useLiveReload } from "@/lib/jobs";
import { toast } from "@/lib/toast";
import { PageScroll } from "@/components/PageScroll";
import { StreamerBadge } from "@/components/StreamerBadge";
import { Modal } from "@/components/Modal";
import { LoadError } from "@/components/SettingsCard";
import { Button, Pill } from "@/components/ui";

const states:Record<string,[string,""|"ok"|"warn"|"bad"]>={created:["В очереди",""],active:["В работе","warn"],completed:["Завершено","ok"],failed:["Сбой","bad"],cancelled:["Отменено",""],expired:["Истекло время","bad"],retry:["Ожидает повтора","warn"]};
const pending=new Set(["created","active","retry"]);
const groupKey=(group:JobGroup)=>group.name+":"+(group.streamer??"");
function groupState(group:JobGroup):[string,""|"ok"|"warn"|"bad"] {
  if(group.active)return ["Выполняется","warn"];
  if(group.waiting)return ["В очереди","warn"];
  if(["failed","expired"].includes(group.state))return ["Нужна проверка","bad"];
  return group.recurring?["Повторяющаяся",""]:states[group.state]??["Ожидание",""];
}
function resultFacts(output:unknown){
  if(!output||typeof output!=="object")return [];
  const values=output as Record<string,unknown>;
  const labels:Record<string,string>={rendered:"Клипов",replaced:"Заменено",skipped:"Пропущено",found:"Эфиров",added:"Новых",words:"Слов распознано",segments:"Фраз",frames:"Фрагментов звука",inspected:"Кандидатов проверено",collected:"Видео обновлено",categories:"Категорий"};
  return Object.entries(labels).flatMap(([key,label])=>typeof values[key]==="number"?[{label,value:Number(values[key]).toLocaleString("ru-RU")}]:[]);
}
export default function JobsPage(){
  const [groups,setGroups]=useState<JobGroup[]|null>(null),[error,setError]=useState("");
  const [filter,setFilter]=useState("all"),[query,setQuery]=useState(""),[selected,setSelected]=useState<JobGroup|null>(null);
  const load=useCallback(()=>{void api.get<JobGroup[]>("/api/jobs/groups").then(rows=>{setGroups(rows);setError("");}).catch(()=>setError("Не удалось загрузить задания"));},[]);
  useLiveReload(load);
  const visible=(groups??[]).filter(group=>(filter==="all"||filter==="recurring"&&group.recurring||filter==="active"&&group.active+group.waiting>0||filter==="failed"&&group.failed>0)&&(jobAction(group)+" "+(group.streamerName??group.streamer??"Платформа")).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <><div className="page-toolbar"><div className="filter-tabs" role="group" aria-label="Фильтр заданий">{[["all","Все"],["recurring","Повторяющиеся"],["active","В работе"],["failed","Со сбоями"]].map(([id,label])=><button key={id} aria-pressed={filter===id} onClick={()=>setFilter(id!)}>{label}</button>)}</div><input className="field toolbar-search" aria-label="Найти задание" placeholder="Стример или задача" value={query} onChange={e=>setQuery(e.target.value)}/><span className="toolbar-count">{groups?visible.length:"…"}</span></div>
  <PageScroll>{error&&<LoadError message={error} retry={load}/>} {!groups&&!error&&<p role="status">Загрузка заданий…</p>}{groups&&!visible.length&&<div className="empty">Заданий не найдено</div>}
    <div className="task-grid">{visible.map(group=>{const [label,tone]=groupState(group);return <article className="task-card task-group" key={groupKey(group)}>
      <header><h2>{jobAction(group)}</h2><Pill tone={tone}>{label}</Pill></header>
      <div>{group.streamer?<StreamerBadge login={group.streamer} name={group.streamerName} avatar={group.avatar}/>:<span className="platform-badge">CF <span>Платформа</span></span>}</div>
      <dl className="task-facts"><div><dt>Запусков</dt><dd>{group.runs}</dd></div><div><dt>Завершено</dt><dd>{group.completed}</dd></div><div><dt>Сбоев</dt><dd>{group.failed}</dd></div></dl>
      <footer><span className="muted">{group.runs?"Последний запуск · "+when(group.createdAt):"Запусков пока нет"}</span><Button size="sm" onClick={()=>setSelected(group)}>Открыть задачу</Button></footer>
    </article>;})}</div>
  </PageScroll>{selected&&<TaskHistory group={groups?.find(group=>groupKey(group)===groupKey(selected))??selected} onClose={()=>setSelected(null)} onChange={load}/>}</>;
}
function TaskHistory({group,onClose,onChange}:{group:JobGroup;onClose:()=>void;onChange:()=>void}){
  const {viewer}=useSession();
  const [rows,setRows]=useState<JobRow[]>([]),[offset,setOffset]=useState<number|null>(0),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [cancelling,setCancelling]=useState("");
  const load=useCallback(async(next=0)=>{setLoading(true);try{const params=new URLSearchParams({name:group.name,streamer:group.streamer??"",offset:String(next)});const result=await api.get<{runs:JobRow[];nextOffset:number|null}>("/api/jobs/group-runs?"+params);setRows(old=>next?[...old.filter(row=>!result.runs.some(newRow=>newRow.id===row.id)),...result.runs]:result.runs);setOffset(result.nextOffset);setError("");}catch{setError("Не удалось загрузить запуски");}finally{setLoading(false);}},[group.name,group.streamer]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(!group.active&&!group.waiting)return;const timer=setInterval(()=>void load(),10000);return()=>clearInterval(timer);},[group.active,group.waiting,load]);
  const cancel=async(id:string)=>{setCancelling(id);try{await api.post("/api/jobs/cancel/"+id);await load();onChange();}catch(e){toast.error(String(e));}finally{setCancelling("");}};
  const canCancel=(row:JobRow)=>viewer.isAdmin&&pending.has(row.state)&&!row.name.startsWith("platform.");
  const hasMaterials=rows.some(row=>row.objectHref),hasActions=rows.some(canCancel);
  return <Modal title={jobAction(group)} onClose={onClose} wide><div className="task-history-heading">{group.streamer?<StreamerBadge login={group.streamer} name={group.streamerName} avatar={group.avatar}/>:<span className="platform-badge">CF <span>Платформа</span></span>}<span>{group.recurring?"Повторяющаяся задача":"Задача"} · запусков: {group.runs}</span></div>
    {error&&<LoadError message={error} retry={()=>void load()}/>}
    {rows.length>0&&<div className="task-history-table" tabIndex={0} role="region" aria-label="История запусков">
      <table aria-label="Запуски задачи"><thead><tr><th scope="col">Создано</th><th scope="col">Статус</th>{hasMaterials&&<th scope="col">Эфир</th>}<th scope="col">Результат</th><th scope="col">Начало</th><th scope="col">Завершение</th>{hasActions&&<th scope="col">Действия</th>}</tr></thead>
        <tbody>{rows.map(row=>{const [label,tone]=states[row.state]??["Ожидание",""];const facts=resultFacts(row.output),failed=["failed","expired"].includes(row.state);return <tr key={row.id}>
          <th scope="row" className="task-run-date">{when(row.createdAt)}</th>
          <td><Pill tone={tone}>{label}</Pill></td>
          {hasMaterials&&<td className="task-run-material">{row.objectHref?<Link href={row.objectHref} onClick={onClose}>{row.objectTitle??"Открыть эфир"}</Link>:<span className="muted">—</span>}</td>}
          <td className="task-run-result">{facts.length>0&&<dl>{facts.map(fact=><div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}{failed&&<p className="task-error">Запуск не удалось завершить.</p>}{!facts.length&&!failed&&<span className="muted">—</span>}</td>
          <td className="task-run-date">{when(row.startedAt)}</td><td className="task-run-date">{when(row.completedAt)}</td>
          {hasActions&&<td>{canCancel(row)?<Button size="sm" busy={cancelling===row.id} onClick={()=>void cancel(row.id)}>Отменить запуск</Button>:<span className="muted">—</span>}</td>}
        </tr>;})}</tbody>
      </table>
    </div>}
    {loading&&<p role="status">Загрузка запусков…</p>}{!loading&&!error&&!rows.length&&<div className="empty">История появится после первого запуска задачи.</div>}{offset!==null&&rows.length>0&&<Button busy={loading} onClick={()=>void load(offset)}>Ещё запуски</Button>}
  </Modal>;
}
