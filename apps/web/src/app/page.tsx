"use client";

/** Live overview of autonomous processing and available results. */
import { useSession } from "@/lib/session";
import { useCatalog } from "@/lib/catalog-cache";
import { Operations } from "@/components/Operations";
import { StreamerBadge } from "@/components/StreamerBadge";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { JobButton } from "@/components/ui";
import { api, hhmm, when } from "@/lib/api";

interface Summary {
  games: number; streamers: number; vods: number; ready: number;
  runs: number; clips: number; published: number; blocked: number;
}

interface Proposal {
  id: string;
  streamer: string;
  displayName: string | null;
  avatar: string | null;
  game: string | null;
  title: string | null;
  duration: number | null;
  publishedAt: string | null;
}

export default function OverviewPage() {
  const {viewer}=useSession();
  const [page,setPage] = useState(0);
  const [pageSize,setPageSize] = useState(2);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const mobile = window.matchMedia("(max-width:800px)");
    const measure = () => {
      const columns = getComputedStyle(el).gridTemplateColumns.split(" ").length;
      setPageSize(mobile.matches ? 4 : Math.max(1, Math.floor(el.clientHeight / 126)) * columns);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    mobile.addEventListener("change", measure);
    return () => { observer.disconnect(); mobile.removeEventListener("change", measure); };
  }, []);
  const {data:summary,error:summaryError}=useCatalog<Summary>("/api/summary");
  const {data:proposalData,error:proposalError,loading,refresh}=useCatalog<Proposal[]>("/api/proposals");
  const proposals=proposalData??[];

  useEffect(()=>setPage(v=>Math.min(v,Math.max(0,Math.ceil(proposals.length/pageSize)-1))),[proposals.length,pageSize]);

  return <div className="overview">
    <section className="overview-intro" aria-label="Сводка">
    <div className="metric-strip">{[["Готовые клипы",summary?.clips],["Публичные видео",summary?.published],...(viewer.role!=="user"?[["Стримеры",summary?.streamers]]:[]),["Записи эфиров",summary?.vods]].map(([label,value])=><div className="metric" key={String(label)}><span>{label}</span><strong>{value??"—"}</strong></div>)}</div>
    {summaryError&&<p role="alert">Не удалось обновить сводку</p>}
    </section><div className={`overview-columns${viewer.isAdmin?"":" overview-personal"}`}>
      <section className="surface overview-queue" aria-label="Следующие эфиры"><div className="surface-heading"><h2>Следующие эфиры</h2><span className="count-badge">{proposalData?proposals.length:"…"}</span></div>
        <div className="proposal-list" ref={listRef}>{proposals.slice(Math.min(page,Math.max(0,Math.ceil(proposals.length/pageSize)-1))*pageSize,(Math.min(page,Math.max(0,Math.ceil(proposals.length/pageSize)-1))+1)*pageSize).map(proposal=><ProposalRow key={proposal.id} proposal={proposal}/>)}{loading&&<div className="empty" role="status">Загрузка эфиров…</div>}{proposalError&&<div className="empty" role="alert">Не удалось обновить эфиры. <button className="btn" onClick={refresh}>Повторить</button></div>}{proposalData&&!proposals.length&&!proposalError&&<div className="empty">Подходящих эфиров пока нет</div>}</div>
        <div className="overview-pagination"><button className="btn" disabled={page===0} onClick={()=>setPage(v=>Math.max(0,v-1))}>← Назад</button><span>{Math.min(page+1,Math.max(1,Math.ceil(proposals.length/pageSize)))} / {Math.max(1,Math.ceil(proposals.length/pageSize))}</span><button className="btn" disabled={(page+1)*pageSize>=proposals.length} onClick={()=>setPage(v=>v+1)}>Далее →</button></div>
      </section>
      {viewer.isAdmin&&<aside className="overview-aside"><Operations compact/></aside>}
    </div>
  </div>;
}

function ProposalRow({ proposal }: { proposal: Proposal }) {
  return (
    <div className="proposal">
      <div className="who">
        <b>
          {proposal.title ?? "Эфир без названия"}
        </b>
        <div className="proposal-meta"><StreamerBadge login={proposal.streamer} name={proposal.displayName} avatar={proposal.avatar}/><span className="muted">
          {proposal.game ?? "Без категории"} · {hhmm(proposal.duration)} · эфир{" "}
          {when(proposal.publishedAt)}
        </span></div>
      </div>
      <Link href={`/vods/${proposal.id}`} className="btn proposal-details">
        Подробнее
      </Link>
      <JobButton
        size="sm"
        variant="primary"
        target={proposal.id}
        onRun={() => api.post(`/api/jobs/pipeline/${proposal.id}`, {})}
      >
        Нарезать
      </JobButton>
    </div>
  );
}

