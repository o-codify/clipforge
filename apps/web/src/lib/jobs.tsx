"use client";

/**
 * Живое состояние заданий, общее для всех страниц.
 *
 * Раньше страница ставила задание и забывала о нём: вернувшись на канал,
 * невозможно было понять, идёт что-то или нет, и задание ставилось
 * повторно. Здесь один опрос на всё приложение, и любая страница может
 * спросить: «есть ли сейчас работа по этому эфиру».
 *
 * Опрос учащается, пока что-то выполняется, и замедляется в тишине -
 * постоянный частый запрос ради пустого списка это лишняя нагрузка и
 * ничего больше.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";

import { api, type JobRow } from "@/lib/api";

interface JobsState {
  jobs: JobRow[];
  /** Задание по объекту, если оно сейчас в очереди или выполняется. */
  activeFor: (target: string, kinds?: string[]) => JobRow | null;
  /** Дёрнуть опрос сразу - после того, как сами поставили задание. */
  refresh: () => void;
  /** Меняется, когда меняется состояние любого задания. */
  version: number;
  /** Выполняется ли сейчас хоть что-нибудь. */
  busy: boolean;
}

const Context = createContext<JobsState>({
  jobs: [],
  activeFor: () => null,
  refresh: () => {},
  version: 0,
  busy: false,
});

const RUNNING = new Set(["created", "active", "retry"]);

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stopped = useRef(false);
  const signature = useRef("");
  const inFlight = useRef(false);

  const tick = useCallback(async () => {
    if (stopped.current || inFlight.current) return;
    inFlight.current = true;
    try {
      const [recent, active] = await Promise.all([api.get<JobRow[]>("/api/jobs?limit=20"), api.get<JobRow[]>("/api/jobs/active")]);
      const list = [...active, ...recent.filter(job => !active.some(item => item.id === job.id))];
      if (stopped.current) return;
      setJobs(list);
      const nowBusy = list.some((job) => RUNNING.has(job.state));
      setBusy(nowBusy);

      // Версия растёт при любой смене состояний. Страницы перечитывают
      // свои данные по ней - так завершившийся обход канала сразу
      // приносит новые эфиры, а не после ручного обновления страницы.
      const next = list.map((job) => `${job.id}:${job.state}`).join("|");
      if (next !== signature.current) {
        signature.current = next;
        setVersion((value) => value + 1);
      }

      timer.current = setTimeout(tick, nowBusy ? 3000 : 15000);
    } catch {
      if (!stopped.current) timer.current = setTimeout(tick, 15000);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    stopped.current = false;
    void tick();
    return () => {
      stopped.current = true;
      clearTimeout(timer.current);
    };
  }, [tick]);

  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    void tick();
  }, [tick]);

  const activeFor = useCallback(
    (target: string, kinds?: string[]) =>
      jobs.find(
        (job) =>
          RUNNING.has(job.state) &&
          (job.data?.vodId === target || job.data?.login === target) &&
          (!kinds || kinds.some((kind) => job.name.endsWith(kind))),
      ) ?? null,
    [jobs],
  );

  const value = useMemo(
    () => ({ jobs, activeFor, refresh, version, busy }),
    [jobs, activeFor, refresh, version, busy],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useJobs = (): JobsState => useContext(Context);

/**
 * Данные страницы обновляются сами.
 *
 * Три источника: смена состояния любого задания (закончился обход -
 * появились эфиры), частый опрос пока идёт работа (клипы прогона
 * появляются по одному прямо во время рендера) и редкий фоновый - на
 * случай изменений, которые не проходят через очередь.
 */
export function useLiveReload(load: () => void): void {
  const { version, busy } = useJobs();

  useEffect(load, [load, version]);

  useEffect(() => {
    const interval = setInterval(load, busy ? 4000 : 30_000);
    return () => clearInterval(interval);
  }, [busy, load]);
}

/** Человеческое имя очереди: «heavy.pipeline» ничего не говорит. */
export const JOB_LABELS: Record<string, string> = {
  "heavy.pipeline": "Нарезка",
  "heavy.fetch-vod": "Загрузка исходников",
  "heavy.transcribe-vod": "Распознавание речи",
  "heavy.analyze-vod": "Сигналы звука",
  "heavy.facecam-vod": "Поиск камеры",
  "heavy.render-run": "Рендер",
  "heavy.render-variant": "Монтаж клипов",
  "heavy.clean-clip": "Скрытие QR-кодов и рекламы",
  "heavy.inspect-ads": "Проверка рекламы эфира",
  "light.index-channel": "Обход архивов",
  "light.fetch-vod-info": "Метаданные",
  "light.refresh-streamer": "Профиль",
};

export const jobLabel = (name: string): string => JOB_LABELS[name] ?? name;

export const JOB_COLOURS: Record<string, string> = {
  active: "var(--warn)",
  created: "var(--dimmer)",
  retry: "var(--warn)",
  completed: "var(--ok)",
  failed: "var(--bad)",
  expired: "var(--bad)",
  cancelled: "var(--dimmer)",
};
