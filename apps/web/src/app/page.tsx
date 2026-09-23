"use client";

/** Live overview of autonomous processing and available results. */
import { Operations } from "@/components/Operations";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { JobButton } from "@/components/ui";
import { api, hhmm, when, type GameRow } from "@/lib/api";
import { useLiveReload } from "@/lib/jobs";

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
  const [page,setPage] = useState(0);
  const [pageSize,setPageSize] = useState(2);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(()=>{const el=listRef.current;if(!el)return;const observer=new ResizeObserver(()=>setPageSize(Math.max(1,Math.floor(el.clientHeight/126))));observer.observe(el);return()=>observer.disconnect();},[]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [games, setGames] = useState<GameRow[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);

  const load = useCallback(() => {
    void api.get<Summary>("/api/summary").then(setSummary).catch(() => {});
    void api.get<GameRow[]>("/api/games").then(setGames).catch(() => {});
    void api.get<Proposal[]>("/api/proposals").then(setProposals).catch(() => {});
  }, []);

  useLiveReload(load);

  useEffect(()=>setPage(v=>Math.min(v,Math.max(0,Math.ceil(proposals.length/pageSize)-1))),[proposals.length,pageSize]);

  return <div className="overview">
    <section className="overview-intro" aria-label="Сводка"><div className="page-intro"><div><div className="eyebrow">CLIPFORGE / WORKSPACE</div><h1>Обзор платформы</h1><p className="sub">От эфира до готового клипа. Работа платформы в одном месте.</p></div><Link className="btn btn-primary" href="/clips">Открыть клипы <span aria-hidden>↗</span></Link></div>
    <div className="metric-strip">{[["Готовые клипы",summary?.clips,"Результаты обработки"],["Публичные видео",summary?.published,"Подтверждённые публикации"],["Стримеры",summary?.streamers,"Каналы в каталоге"],["Записи эфиров",summary?.vods,"Материалы для отбора"]].map(([label,value,note])=><div className="metric" key={String(label)}><span>{label}</span><strong>{value??"—"}</strong><small>{note}</small></div>)}</div>
    </section><div className="overview-columns">
      <section className="surface overview-queue" aria-label="Следующие эфиры"><div className="surface-heading"><div><span className="eyebrow">ОБРАБОТКА</span><h2>Следующие эфиры</h2><p>Автоматика выбирает записи по аудитории и доступным ресурсам.</p></div><span className="count-badge">{proposals.length}</span></div>
        <div className="proposal-list" ref={listRef}>{proposals.slice(Math.min(page,Math.max(0,Math.ceil(proposals.length/pageSize)-1))*pageSize,(Math.min(page,Math.max(0,Math.ceil(proposals.length/pageSize)-1))+1)*pageSize).map(proposal=><ProposalRow key={proposal.id} proposal={proposal}/>)}{!proposals.length&&<div className="empty">Подходящих эфиров пока нет. Поиск продолжается автоматически.</div>}</div>
        <div className="overview-pagination"><button className="btn" disabled={page===0} onClick={()=>setPage(v=>Math.max(0,v-1))}>← Назад</button><span>{Math.min(page+1,Math.max(1,Math.ceil(proposals.length/pageSize)))} / {Math.max(1,Math.ceil(proposals.length/pageSize))}</span><button className="btn" disabled={(page+1)*pageSize>=proposals.length} onClick={()=>setPage(v=>v+1)}>Далее →</button></div>
      </section>
      <aside className="overview-aside"><section className="surface"><div className="surface-heading"><div><span className="eyebrow">ПЛАТФОРМА</span><h2>Состояние системы</h2></div><span className="status-orbit"/></div><Operations/></section>
    <div className="workspace-links"><Link href="/jobs"><span className="workspace-icon">≡</span><div><b>История обработки</b><small>Прогресс, результаты и диагностика</small></div><span>↗</span></Link><Link href="/games"><span className="workspace-icon">◇</span><div><b>Игры и категории</b><small>{games.length} категорий в каталоге</small></div><span>↗</span></Link></div>
      </aside>
    </div>
  </div>;
}

function ProposalRow({ proposal }: { proposal: Proposal }) {
  return (
    <div className="proposal">
      {proposal.avatar ? (
        <img src={proposal.avatar} alt="" />
      ) : (
        <span className="dot" style={{ width: 32, height: 32 }} />
      )}
      <div className="who">
        <b>
          {proposal.title ?? "Эфир без названия"}
        </b>
        <span className="muted">
          {proposal.displayName ?? proposal.streamer} · {proposal.game ?? "Без категории"} · {hhmm(proposal.duration)} · эфир{" "}
          {when(proposal.publishedAt)}
        </span>
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

