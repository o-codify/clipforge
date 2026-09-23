"use client";

/**
 * Боковое меню: навигация по содержимому площадки.
 *
 * Устроено как в YouTube: сверху разделы, ниже раскрывающиеся списки -
 * стримеры, игры, задачи. Раскрытие запоминается, потому что
 * переключаться между каналом и игрой приходится постоянно, и
 * схлопывающийся при каждом переходе список злит быстрее всего.
 *
 * Профиля здесь нет: он живёт в верхней полосе. Меню - про содержимое, а
 * не про «я и мои настройки».
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { api, type GameRow, type StreamerRow, type Viewer } from "@/lib/api";
import { JOB_COLOURS, jobLabel, useJobs } from "@/lib/jobs";

const REMEMBER = "clipforge.groups";

interface Groups {
  streamers: boolean;
  games: boolean;
  jobs: boolean;
}

export function Sidebar({ viewer }: { viewer: Viewer }) {
  const path = usePathname();
  const [catalogOpen,setCatalogOpen] = useState(false);
  const { jobs } = useJobs();
  const [streamers, setStreamers] = useState<StreamerRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [open, setOpen] = useState<Groups>({
    streamers: true,
    games: true,
    jobs: true,
  });

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER);
      if (saved) setOpen(JSON.parse(saved));
    } catch {
      // Хранилище может быть недоступно - тогда просто всё открыто.
    }
  }, []);

  const { version } = useJobs();
  useEffect(() => {
    void api.get<StreamerRow[]>("/api/streamers").then(setStreamers).catch(() => {});
    void api.get<GameRow[]>("/api/games").then(setGames).catch(() => {});
    // Обновление по общей версии заданий: закончился обход канала -
    // в меню сразу появляются новые игры и подтягиваются аватарки.
  }, [viewer.actingAs, version]);

  const toggle = (key: keyof Groups) => {
    const next = { ...open, [key]: !open[key] };
    setOpen(next);
    try {
      localStorage.setItem(REMEMBER, JSON.stringify(next));
    } catch {
      // Не запомнилось - не беда.
    }
  };

  const navItem = (href: string, icon: string, label: string) => (
    <Link href={href} className={`nav-item${path === href ? " on" : ""}`}>
      <span className="icon">{icon}</span>
      <span>{label}</span>
    </Link>
  );

  const active = jobs.filter((job) => job.state === "active" || job.state === "created");

  return (
    <aside className={`rail${catalogOpen ? " catalog-open" : ""}`}>
      <Link href="/" className="rail-head">
        <img src="/glitch.svg" alt="" />
        <span>ClipForge</span>
      </Link>

      <nav className="nav">
        {navItem("/", "⌂", "Обзор")}
        {navItem("/clips", "▤", "Клипы")}
        {viewer.isAdmin && navItem("/discovery", "◎", "Поиск стримеров")}
        {navItem("/jobs", "⚙", "Задачи")}
      </nav>

      <button className="btn mobile-catalog" onClick={()=>setCatalogOpen(v=>!v)}>{catalogOpen ? "Скрыть каталог" : "Каналы и категории"}</button>
      <Group
        title="Стримеры"
        count={streamers.length}
        open={open.streamers}
        onToggle={() => toggle("streamers")}
        empty="Пока никого"
      >
        {streamers.map((streamer) => (
          <Link
            key={streamer.login}
            href={`/streamers/${streamer.login}`}
            className={`entry${path === `/streamers/${streamer.login}` ? " on" : ""}`}
            title={streamer.live ? `в эфире: ${streamer.liveGame ?? ""}` : undefined}
          >
            {streamer.avatar ? (
              <img className="avatar" src={streamer.avatar} alt="" />
            ) : (
              <span className="avatar placeholder">
                {(streamer.displayName ?? streamer.login).slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="name">{streamer.displayName ?? streamer.login}</span>
            {streamer.live ? (
              <span className="live" />
            ) : (
              <span className="num">{streamer.clips}</span>
            )}
          </Link>
        ))}
      </Group>

      <Group
        title="Игры"
        count={games.length}
        open={open.games}
        onToggle={() => toggle("games")}
        empty="Пока пусто"
      >
        {games.map((game) => (
          <Link
            key={game.slug}
            href={`/games/${game.slug}`}
            className={`entry${path === `/games/${game.slug}` ? " on" : ""}`}
          >
            {game.boxArt ? (
              <img className="box" src={game.boxArt} alt="" />
            ) : (
              <span className="box placeholder">{game.title.slice(0, 1)}</span>
            )}
            <span className="name">{game.title}</span>
            <span className="num">{game.clips}</span>
          </Link>
        ))}
      </Group>

      <Group
        title="Задачи"
        count={active.length}
        open={open.jobs}
        onToggle={() => toggle("jobs")}
        empty="Заданий не было"
      >
        {jobs.slice(0, 8).map((job) => {
          const target = String(job.data?.vodId ?? job.data?.login ?? "");
          return (
            <Link key={job.id} href="/jobs" className="entry" title={job.name}>
              <span
                className={`dot${job.state === "active" ? " dot-active" : ""}`}
                style={{ background: JOB_COLOURS[job.state] ?? "var(--dimmer)" }}
              />
              <span className="name">
                {jobLabel(job.name)}
                {target && <span className="muted"> · {target}</span>}
              </span>
            </Link>
          );
        })}
      </Group>
    </aside>
  );
}

function Group({
  title,
  count,
  open,
  onToggle,
  empty,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  empty: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  const isEmpty = items.flat().filter(Boolean).length === 0;

  return (
    <div className="group">
      <button className="group-head" onClick={onToggle}>
        <span className={`chevron${open ? " open" : ""}`}>›</span>
        {title}
        <span className="group-count">{count}</span>
      </button>
      {open && (isEmpty ? <div className="entry muted">{empty}</div> : children)}
    </div>
  );
}
