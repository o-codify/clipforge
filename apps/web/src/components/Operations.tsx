"use client";
import { useCallback, useState } from "react";
import { api, type Viewer } from "@/lib/api";
import { useLiveReload } from "@/lib/jobs";
import { Button, Card, Pill } from "./ui";
import { toast } from "@/lib/toast";

export function Operations() {
  const [status, setStatus] = useState<any>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void api.get("/api/operations").then(s => { setStatus(s); setError(""); }).catch(e => setError(String(e)));
    void api.get<{viewer:Viewer}>("/api/auth/me").then(r => setViewer(r.viewer)).catch(() => {});
  }, []);
  useLiveReload(load);
  const paused = status?.runtime?.settings?.paused;
  const scheduler = status?.runtime?.scheduler;
  return <Card>
    <div className="form-row"><b>Автономная обработка</b>
      <Pill tone={error || !status?.online ? "bad" : paused ? "warn" : "ok"}>
        {error ? "Нет связи" : !status ? "Проверка…" : !status.online ? "Обработка недоступна" : paused ? "На паузе" : "Работает"}
      </Pill>
      {viewer?.isAdmin && status && <Button size="sm" onClick={async () => {
        try { await api.post("/api/operations/pause", { paused: !paused }); load(); } catch(e) { toast.error(String(e)); }
      }}>{paused ? "Возобновить" : "Приостановить новые задания"}</Button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {status?.runtime && <>
      {status.runtime.settings?.developmentMode && <p><b>Режим разработки</b> · Автоматическая нарезка и публикация выключены. Ручной запуск создаёт один клип.</p>}
      <p>{paused ? "Новые автоматические задания остановлены. Уже запущенные завершаются." : scheduler?.reason ?? "Ожидается первый обход планировщика."}</p>
      {scheduler?.vodId && <p>Выбран <a href={`/vods/${scheduler.vodId}`}>Эфир канала {scheduler.streamer} →</a></p>}
      <div className="meta">
        {typeof scheduler?.freeGb === "number" && <>Свободно {scheduler.freeGb.toFixed(1)} ГБ · </>}
        {scheduler?.dailyLimit && <>Бюджет: {scheduler.dailyLimit} эфира/сутки · </>}
        Twitch: {status.twitchConfigured ? "Настроен" : "Нужны ключи приложения"}
        {status.runtime.discovery?.inspected != null && <> · Последний поиск: {status.runtime.discovery.inspected} кандидатов, добавлено {status.runtime.discovery.added}</>}
      </div>
      {status.runtime.discovery?.state === "error" && <p role="alert">Поиск: {status.runtime.discovery.reason}</p>}
    </>}
  </Card>;
}
