"use client";

/**
 * Каркас страницы: содержимое и подключаемый помощник.
 *
 * Кто вошёл, выясняется здесь один раз и передаётся вниз. Пока не
 * выяснили - не показываем ничего: иначе на долю секунды мелькает
 * интерфейс, которого у этого человека может и не быть.
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PlatformAssistant } from "@/components/PlatformAssistant";

import { api, type Viewer } from "@/lib/api";
import { JobsProvider } from "@/lib/jobs";
import { Toaster } from "@/lib/toast";

const PUBLIC_PATHS = new Set(["/login", "/about", "/privacy", "/terms"]);

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const isPublic = PUBLIC_PATHS.has(path);
  const router = useRouter();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [error,setError] = useState("");
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (isPublic) return;
    let active = true;
    setChecked(false);
    void api
      .get<{ viewer: Viewer | null }>("/api/auth/me")
      .then(({ viewer: who }) => {
        if (!active) return;
        setError("");
        setViewer(who);
        setChecked(true);
        if (!who) router.replace("/login");
      })
      .catch(() => { if (active) { setChecked(true); setError("Не удалось связаться с сервером"); } });
    return () => { active = false; };
  }, [path, isPublic, router]);

  if (isPublic) return <>{children}</>;
  if (error) return <main className="main"><h1>Сервер недоступен</h1><p>{error}</p><button className="btn" onClick={()=>window.location.reload()}>Повторить</button></main>;
  if (!checked || !viewer) return <main className="main">Проверка входа…</main>;

  return (
    <JobsProvider>
      <div className="shell">

        <div className="content">

          <main className="main">{children}</main>
        </div>
        <PlatformAssistant viewer={viewer} />
        <Toaster />
      </div>
    </JobsProvider>
  );
}
