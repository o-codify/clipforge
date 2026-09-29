"use client";

/** Persistent page identity, processing status and account menu. */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { api, type StreamerRow, type Viewer } from "@/lib/api";
import { jobLabel, useJobs } from "@/lib/jobs";
import { useSession } from "@/lib/session";
import { pageTitle, sectionNumber } from "@/lib/navigation";
import { PageIdentity } from "./SiteFrame";
import { StreamerBadge } from "./StreamerBadge";
import { useCatalog } from "@/lib/catalog-cache";
import { toast } from "@/lib/toast";

export function Header() {
  const { viewer, updateViewer, logout } = useSession();
  const path = usePathname();
  const router = useRouter();
  const { jobs } = useJobs();
  const [open, setOpen] = useState(false);
  const { data: streamers = [] } = useCatalog<StreamerRow[]>("/api/streamers", open && viewer.isAdmin);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape); };
  }, []);

  const running = jobs.filter((job) => job.state === "active");
  const waiting = jobs.filter((job) => job.state === "created" || job.state === "retry").length;

  const actAs = async (streamer: string | null) => {
    try { const { viewer: updated } = await api.post<{ viewer: Viewer }>(
      "/api/auth/act-as",
      { streamer },
    );
    updateViewer(updated);
    router.replace("/");
    setOpen(false);
    } catch (error) { toast.error(String(error)); }
  };

  const initials = (viewer.isPreview ? viewer.actingAs! : viewer.displayName || viewer.login).slice(0, 1).toUpperCase();

  return (
    <header className="topbar site-masthead">
      <PageIdentity index={sectionNumber(path)} area="Рабочее пространство" title={viewer.role === "user" && path.startsWith("/streamers/") ? "Мой канал" : pageTitle(path, viewer.isAdmin)} />
      <Link href="/jobs" className="topbar-status" aria-label={running.length ? `Задания: ${running.length} в работе` : "Перейти к заданиям"}>
        {running.length > 0 ? (
          <>
            <span className="dot dot-active" />
            <span>
              {jobLabel(running[0]!.name)}
              {running[0]!.data?.vodId ? (
                <span className="muted"> · {String(running[0]!.data.vodId)}</span>
              ) : running[0]!.data?.login ? (
                <StreamerBadge login={String(running[0]!.data.login)} linked={false}/>
              ) : null}
            </span>
            {(running.length > 1 || waiting > 0) && (
              <span className="muted">
                И ещё {running.length - 1 + waiting}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="dot" />
            <span className="muted">{waiting ? `В очереди: ${waiting}` : "Нет активных заданий"}</span>
          </>
        )}
      </Link>

      <div className="topbar-user" ref={box}>
        {viewer.isPreview && (
          <button className="acting-tag" onClick={() => actAs(null)} title="Выйти из просмотра"><StreamerBadge login={viewer.actingAs!} linked={false}/> Выйти из просмотра</button>
        )}
        <button className="avatar-button" aria-label="Меню аккаунта" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {!viewer.isPreview&&<span className="avatar-initials">{initials}</span>}
          <span className="avatar-name">
            {viewer.isPreview ? <StreamerBadge login={viewer.actingAs!} linked={false}/> : <b>{viewer.displayName}</b>}
            <span>{viewer.isAdmin ? "Администратор" : viewer.role === "moderator" ? "Модератор" : "Пользователь"}</span>
          </span>
          <span className="chevron-down">▾</span>
        </button>

        {open && (
          <div className="menu">
            <Link className="menu-item" href="/me" onClick={() => setOpen(false)}>
              Мой профиль
            </Link>

            {viewer.isAdmin && (
              <>
                <div className="menu-label">Смотреть глазами</div>
                <div className="menu-scroll">
                  {viewer.actingAs && (
                    <button className="menu-item" onClick={() => actAs(null)}>
                      Вернуться к своему виду
                    </button>
                  )}
                  {streamers.map((streamer) => (
                    <button
                      key={streamer.login}
                      className={`menu-item${viewer.actingAs === streamer.login ? " on" : ""}`}
                      onClick={() => actAs(streamer.login)}
                    >
                      <StreamerBadge login={streamer.login} name={streamer.displayName} avatar={streamer.avatar} linked={false}/>
                    </button>
                  ))}
                </div>
              </>
            )}

            <button
              className="menu-item danger"
              onClick={async () => {
                try { await logout(); } catch (error) { toast.error(String(error)); }
              }}
            >
              Выйти
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
