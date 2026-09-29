"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useJobs } from "./jobs";

type Entry = { data?: unknown; time: number; version?: number; pending?: Promise<unknown> };
const Context = createContext<Map<string, Entry> | null>(null);
export function CatalogCache({ children }: { children: React.ReactNode }) {
  const cache = useRef(new Map<string, Entry>());
  return <Context.Provider value={cache.current}>{children}</Context.Provider>;
}

/** Scoped to the mounted account view; deduplicates requests and retains the last result. */
export function useCatalog<T>(path: string, enabled = true) {
  const cache = useContext(Context)!;
  const { version } = useJobs();
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<T | undefined>(() => cache.get(path)?.data as T | undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setData(cache.get(path)?.data as T | undefined);
    setError("");
    const load = async () => {
      let entry = cache.get(path);
      if (!entry) { entry = { time: 0 }; cache.set(path, entry); }
      try {
        if (Date.now() - entry.time > 30_000 || entry.version !== version) {
          entry.pending ??= api.get<T>(path).then(value => { entry!.data = value; entry!.time = Date.now(); entry!.version = version; return value; }).finally(() => { entry!.pending = undefined; });
          await entry.pending;
        }
        if (active) { setData(entry.data as T); setError(""); }
      } catch { if (active) setError("Не удалось загрузить данные. Повторяем подключение…"); }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [cache, path, enabled, version, retry]);
  const refresh = () => { const entry = cache.get(path); if (entry) entry.time = 0; setRetry(value => value + 1); };
  return { data, error, refresh, loading: enabled && data === undefined && !error };
}
