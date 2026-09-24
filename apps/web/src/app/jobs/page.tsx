"use client";
import { useSession } from "@/lib/session";

/**
 * Задания: что выполняется и что уже отработало.
 *
 * Страница обновляется сама, пока есть работа. Смотреть на застывшие
 * цифры и гадать, идёт ли что-нибудь, - худшее, что может делать
 * интерфейс с фоновыми задачами.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { jobAction, jobNarration } from "@/lib/job-description";

import { api, when, type JobRow } from "@/lib/api";
import { toast } from "@/lib/toast";

const STATES: Record<string, [string, string]> = {
  created: ["В очереди", ""],
  active: ["Идёт", "warn"],
  completed: ["Готово", "ok"],
  failed: ["Сбой", "bad"],
  cancelled: ["Снято", ""],
  expired: ["Просрочено", "bad"],
  retry: ["Повтор", "warn"],
};

/** Задание ещё можно снять: стоит в очереди или выполняется. */
const CANCELLABLE = new Set(["created", "active", "retry"]);

export default function JobsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<{id:number;message:string;createdAt:string}[]>([]);
  const [error,setError] = useState("");
  useEffect(()=>{ if(!selected) return; const load=()=>{void api.get<typeof events>(`/api/jobs/${selected}/events`).then(setEvents).catch(e=>setError(String(e)));};load();const t=setInterval(load,2000);return()=>clearInterval(t);},[selected]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [filter, setFilter] = useState<"all" | "active" | "done" | "failed">("all");
  const { viewer } = useSession(); const isAdmin = viewer.isAdmin;
  /** Уже отправленные отмены - чтобы кнопка не жалась дважды. */
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());

  useEffect(() => {
    const load = () => {
      void api.get<JobRow[]>("/api/jobs?limit=60").then(r=>{setJobs(r);setError("");}).catch(e=>setError(String(e)));
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  const cancel = async (id: string) => {
    setCancelling((prev) => new Set(prev).add(id));
    try {
      await api.post(`/api/jobs/cancel/${id}`, {});
    } catch (error) {
      toast.error(String(error));
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const visibleJobs = jobs.filter(job => filter === "all" || (filter === "active" ? CANCELLABLE.has(job.state) : filter === "done" ? job.state === "completed" : ["failed", "expired"].includes(job.state)));
  return (
    <>

      {error && <p role="alert">{error}</p>}
      {isAdmin && selected && <section className="card"><div className="form-row"><b>Журнал задания</b><button className="btn" onClick={()=>setSelected(null)}>Закрыть</button></div><pre style={{whiteSpace:"pre-wrap",maxHeight:360,overflow:"auto"}}>{events.length ? events.map(e=>`${new Date(e.createdAt).toLocaleTimeString()} ${e.message}`).join("\n") : "Сообщений пока нет"}</pre></section>}
      <p className="sub">
        Текущая работа, готовые результаты и задания, которым нужно внимание.
      </p>
      <div className="filter-tabs" role="group" aria-label="Фильтр заданий">{([["all","Все"],["active","В работе"],["done","Завершены"],["failed","Сбои"]] as const).map(([id,label])=><button key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}</div>

      {visibleJobs.length === 0 ? (
        <div className="card empty">В этой группе пока нет заданий.</div>
      ) : (
        <div className="job-list">
          {visibleJobs.map(job => {
            const [label, cls] = STATES[job.state] ?? ["Ожидание", ""];
            return <article className="card job-card" key={job.id}>
              <div className="form-row"><h2>{jobAction(job)}</h2><span className={`pill ${cls}`}>{label}</span></div>
              {job.streamerName && <b>{job.streamerName}</b>}
              {job.objectHref ? <Link className="job-object" href={job.objectHref}>{job.objectTitle ?? "Открыть эфир"} →</Link> : <p>{job.objectTitle ?? "Материал недоступен"}</p>}
              <p className="sub">{jobNarration(job)}</p>
              <div className="meta">Создано {when(job.createdAt)}{job.completedAt && ` · Завершено ${when(job.completedAt)}`}</div>
              {job.state === "active" && <div className="bar idle" aria-label="Задание выполняется"><i /></div>}
              {job.state === "completed" && <p>{humanizeOutput(job.output)}</p>}
              {isAdmin && <details><summary>Диагностика администратора</summary><pre>{JSON.stringify({id:job.id, queue:job.name, data:job.data, output:job.output}, null, 2)}</pre><button className="btn" onClick={() => { setEvents([]); setSelected(job.id); }}>Открыть технический журнал</button></details>}
              {isAdmin && CANCELLABLE.has(job.state) && <button className="btn" disabled={cancelling.has(job.id)} onClick={() => cancel(job.id)}>{cancelling.has(job.id) ? "Отменяется…" : "Отменить задание"}</button>}
            </article>;
          })}
        </div>
      )}
    </>
  );
}

/**
 * Итог задания по-человечески. Сырой JSON в таблице читается как мусор,
 * а важны две-три цифры.
 */
function humanizeOutput(output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const data = output as Record<string, unknown>;

  const parts: string[] = [];
  if (typeof data.rendered === "number") parts.push(`клипов ${data.rendered}`);
  if (typeof data.replaced === "number" && data.replaced > 0) parts.push(`заменено ${data.replaced}`);
  if (typeof data.skipped === "number" && data.skipped > 0) parts.push(`пропущено ${data.skipped}`);
  if (typeof data.found === "number") parts.push(`эфиров ${data.found}`);
  if (typeof data.added === "number" && data.added > 0) parts.push(`новых ${data.added}`);
  if (typeof data.words === "number") parts.push(`слов ${data.words}`);
  if (typeof data.frames === "number") parts.push(`кадров ${data.frames}`);
  return parts.join(", ");
}
