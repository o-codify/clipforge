"use client";

/**
 * Верхняя полоса: где я нахожусь и кто я.
 *
 * Профиль переехал сюда из подвала меню. В меню ему не место: там
 * навигация по содержимому площадки, а не «я и мои настройки». Заодно
 * здесь видно, что прямо сейчас выполняется - это то, что хочется знать
 * с любой страницы, а не только со страницы задач.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { api, type StreamerRow, type Viewer } from "@/lib/api";
import { jobLabel, useJobs } from "@/lib/jobs";
import { useSession } from "@/lib/session";
import { pageTitle } from "@/lib/navigation";
import { toast } from "@/lib/toast";

export function Header() {
  const { viewer, updateViewer, logout } = useSession();
  const path = usePathname();
  const { jobs } = useJobs();
  const [open, setOpen] = useState(false);
  const [streamers, setStreamers] = useState<StreamerRow[]>([]);
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

  useEffect(() => {
    if (open && viewer.isAdmin && streamers.length === 0) {
      void api.get<StreamerRow[]>("/api/streamers").then(setStreamers).catch(() => {});
    }
  }, [open, viewer.isAdmin, streamers.length]);

  const running = jobs.filter((job) => job.state === "active");
  const waiting = jobs.filter((job) => job.state === "created" || job.state === "retry").length;

  const actAs = async (streamer: string | null) => {
    try { const { viewer: updated } = await api.post<{ viewer: Viewer }>(
      "/api/auth/act-as",
      { streamer },
    );
    updateViewer(updated);
    setOpen(false);
    } catch (error) { toast.error(String(error)); }
  };

  const initials = (viewer.displayName || viewer.login).slice(0, 1).toUpperCase();

  return (
    <header className="topbar">
      <div className="workspace-heading"><span>ClipForge / Рабочее пространство</span><h1>{pageTitle(path, viewer.isAdmin)}</h1></div>
      <Link href="/jobs" className="topbar-status" aria-label={running.length ? `Задания: ${running.length} в работе` : "Перейти к заданиям"}>
        {running.length > 0 ? (
          <>
            <span className="dot dot-active" />
            <span>
              {jobLabel(running[0]!.name)}
              {running[0]!.data?.vodId ? (
                <span className="muted"> · {String(running[0]!.data.vodId)}</span>
              ) : running[0]!.data?.login ? (
                <span className="muted"> · {String(running[0]!.data.login)}</span>
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
        {viewer.actingAs && viewer.isAdmin && (
          <span className="acting-tag">
            Смотрите как <b>{viewer.actingAs}</b>
          </span>
        )}
        <button className="avatar-button" aria-label="Меню аккаунта" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="avatar-initials">{initials}</span>
          <span className="avatar-name">
            <b>{viewer.displayName}</b>
            <span>{viewer.isAdmin ? "Администратор" : viewer.role === "moderator" ? "Модератор" : "Пользователь"}</span>
          </span>
          <span className="chevron-down">▾</span>
        </button>

        {open && (
          <div className="menu">
            <Link className="menu-item" href="/me" onClick={() => setOpen(false)}>
              {viewer.isAdmin ? "Настройки площадки" : "Мой профиль"}
            </Link>

            {viewer.isAdmin && (
              <>
                <div className="menu-label">Смотреть глазами</div>
                <div className="menu-scroll">
                  {viewer.actingAs && (
                    <button className="menu-item" onClick={() => actAs(null)}>
                      ← Вернуться к своему виду
                    </button>
                  )}
                  {streamers.map((streamer) => (
                    <button
                      key={streamer.login}
                      className={`menu-item${viewer.actingAs === streamer.login ? " on" : ""}`}
                      onClick={() => actAs(streamer.login)}
                    >
                      {streamer.displayName ?? streamer.login}
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
