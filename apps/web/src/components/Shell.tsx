"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { PlatformAssistant } from "./PlatformAssistant";
import { api, type Viewer } from "@/lib/api";
import { JobsProvider } from "@/lib/jobs";
import { SessionContext, SESSION_EXPIRED } from "@/lib/session";
import { Toaster } from "@/lib/toast";
import { CatalogCache } from "@/lib/catalog-cache";
import { SiteCanvas } from "./SiteFrame";
import { StreamerDirectory } from "./StreamerBadge";

const PUBLIC_PATHS = new Set(["/login", "/about", "/privacy", "/terms"]);

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const isPublic = PUBLIC_PATHS.has(path);
  const router = useRouter();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => { contentRef.current?.scrollTo(0, 0); }, [path]);

  useEffect(() => {
    // Revalidate when entering the workspace, never on an internal transition.
    if (isPublic) { setViewer(null); return; }
    let active = true;
    setError("");
    void api.get<{ viewer: Viewer | null }>("/api/auth/me").then(({ viewer: who }) => {
      if (!active) return;
      setViewer(who);
      if (!who) router.replace("/login");
    }).catch(() => { if (active) setError("Не удалось связаться с сервером"); });
    return () => { active = false; };
  }, [isPublic, router, attempt]);

  useEffect(() => {
    const expired = () => { setViewer(null); router.replace("/login"); };
    if (!isPublic) window.addEventListener(SESSION_EXPIRED, expired);
    return () => window.removeEventListener(SESSION_EXPIRED, expired);
  }, [isPublic, router]);

  const privateAdminPage = path.startsWith("/settings") || ['/discovery','/workers','/publications','/shorts','/analytics'].includes(path);
  const redirect = viewer && !viewer.isAdmin && privateAdminPage ? "/" :
    viewer?.role === "user" && path === "/streamers" ?
      (viewer.actingAs && viewer.actingAs !== "__unlinked_account__" ? `/streamers/${viewer.actingAs}` : "/me") : null;
  useEffect(() => { if (redirect) router.replace(redirect); }, [redirect, router]);

  const logout = useCallback(async () => {
    await api.post("/api/auth/logout");
    if (viewer) sessionStorage.removeItem(`clipforge-chat:${viewer.accountId}:${viewer.actingAs ?? "all"}`);
    setViewer(null);
    router.replace("/login");
  }, [router, viewer]);

  if (isPublic) return <>{children}</>;
  if (error) return <main className="session-loading"><h1>Сервер недоступен</h1><p>{error}</p><button className="btn" onClick={() => setAttempt(value => value + 1)}>Повторить</button></main>;
  if (!viewer) return <main className="session-loading" role="status"><span className="brand-mark" aria-hidden>CF</span><p>Проверка входа…</p></main>;

  return <SessionContext.Provider value={{ viewer, updateViewer: setViewer, logout }}>
    <JobsProvider key={`${viewer.accountId}:${viewer.actingAs ?? "all"}`}>
      <CatalogCache>
      <StreamerDirectory>
      <div className="shell workspace-shell site-frame">
        <SiteCanvas />
        <a href="#workspace-content" className="workspace-skip">К содержимому</a>
        <Sidebar />
        <div className="content">
          <Header />
          <main ref={contentRef} id="workspace-content" className="main" tabIndex={-1}>{redirect ? null : children}</main>
        </div>
        <PlatformAssistant viewer={viewer} />
        <Toaster />
      </div>
      </StreamerDirectory>
      </CatalogCache>
    </JobsProvider>
  </SessionContext.Provider>;
}
