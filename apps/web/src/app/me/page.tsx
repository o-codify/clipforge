"use client";
import { useSession } from "@/lib/session";

/**
 * Личная страница.
 *
 * Для администратора - настройки площадки: что подключено, чем она
 * занимается, какие аккаунты заведены. Для стримера - его собственный
 * канал: что о нём известно и что с его эфирами делают.
 *
 * Раньше профиль висел в подвале меню, где ему не место: меню про
 * содержимое площадки, а не про «я и мои настройки».
 */
import { AccountSettings } from "@/components/AccountSettings";
import { Operations } from "@/components/Operations";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, Card, PageSkeleton, Pill, SectionTitle } from "@/components/ui";
import { api, type PlatformAccount, type StreamerRow } from "@/lib/api";
import { toast } from "@/lib/toast";

interface DiscoveryStatus {
  available: boolean;
  note: string;
}

interface Summary {
  games: number; streamers: number; vods: number; ready: number;
  runs: number; clips: number; published: number; blocked: number;
}

export default function MePage() {
  const { viewer } = useSession();
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [streamers, setStreamers] = useState<StreamerRow[]>([]);
  const [busy, setBusy] = useState("");
  const [youtubeStatus,setYoutubeStatus] = useState<{state:string;reason?:string;channel?:string}|null>(null);
  const [platforms, setPlatforms] = useState<PlatformAccount[]>([]);
  const [platformsState, setPlatformsState] = useState<"loading" | "ready" | "error">("loading");

  const loadPlatforms = async () => {
    setPlatformsState("loading");
    try {
      setPlatforms(await api.get<PlatformAccount[]>("/api/platforms"));
      setPlatformsState("ready");
    } catch { setPlatformsState("error"); }
  };

  useEffect(() => {
    void api.get<Summary>("/api/summary").then(setSummary);
    void api.get<StreamerRow[]>("/api/streamers").then(setStreamers);
    void api
      .get<DiscoveryStatus>("/api/discovery/status")
      .then(setStatus)
      .catch(() => setStatus(null));

    // Возврат с согласия Google: результат приходит параметром адреса.
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("youtube") ?? params.get("twitch");
    if (outcome) {
      window.history.replaceState(null, "", window.location.pathname);
      if (outcome === "connected") toast.info("Канал подключён");
      else toast.error("Подключить канал не удалось: проверьте настройки приложения и принадлежность канала");
    }
  }, []);

  useEffect(() => { if (viewer?.isAdmin) void loadPlatforms(); }, [viewer?.isAdmin]);

  const connectYoutube = async () => {
    setBusy("youtube");
    try {
      const { url } = await api.post<{ url: string }>("/api/platforms/youtube/connect");
      // На страницу согласия - этой же вкладкой: Google вернёт назад в
      // настройки, и результат покажет тост.
      window.location.href = url;
    } catch (error) {
      toast.error(String(error));
      setBusy("");
    }
  };

  const disconnectPlatform = async (id: string) => {
    setBusy(`off:${id}`);
    try {
      const result=await api.del<{state:string}>(`/api/platforms/${id}`);
      toast.info(result.state==="pending"?"Новые публикации остановлены. Повторю отключение автоматически, когда Google ответит.":"Доступ отозван. Данные канала удалены из ClipForge.");
      await loadPlatforms();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy("");
    }
  };

  if (!viewer) return <PageSkeleton />;

  const run = async (key: string, action: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await action();
      // Разовые действия не оставляют видимого следа на странице,
      // поэтому короткое подтверждение - тостом, поверх, без сдвигов.
      toast.info(done);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy("");
    }
  };

  // --- взгляд стримера --------------------------------------------------

  if (viewer.role === "moderator") return <><AccountSettings viewer={viewer}/><Operations/><p>Доступны каталог, клипы и журнал заданий для поддержки пользователей. Изменение чужих аккаунтов и запуск обработки доступны администратору.</p></>;

  if (!viewer.isAdmin) {
    const mine = streamers[0];
    return (
      <>

        <AccountSettings viewer={viewer} />
        <p className="sub">Что площадка знает о канале и что с ним делает.</p>

        {mine && (
          <Card className="profile">
            {mine.avatar ? (
              <img className="profile-avatar" src={mine.avatar} alt="" />
            ) : (
              <span className="profile-avatar placeholder">
                {(mine.displayName ?? mine.login).slice(0, 1).toUpperCase()}
              </span>
            )}
            <div>
              <h2 style={{ margin: 0 }}>{mine.displayName ?? mine.login}</h2>
              <p className="muted">
                twitch.tv/{mine.login}
                {mine.followers ? ` · ${mine.followers.toLocaleString("ru-RU")} фолловеров` : ""}
              </p>
              <div className="pillrow">
                <Pill tone={mine.state === "active" ? "ok" : ""}>
                  {mine.state === "active" ? "Автоматика включена" : "Автоматика выключена"}
                </Pill>
                {mine.live && <Pill tone="bad">В эфире</Pill>}
              </div>
            </div>
          </Card>
        )}

        {summary && (
          <>
            <SectionTitle>Мои цифры</SectionTitle>
            <div className="stats">
              <div className="stat"><b>{summary.vods}</b><span>Эфиров</span></div>
              <div className="stat"><b>{summary.clips}</b><span>Клипов</span></div>
              <div className="stat"><b>{summary.published}</b><span>Опубликовано</span></div>
              <div className="stat"><b>{summary.blocked}</b><span>Снято</span></div>
            </div>
          </>
        )}
      </>
    );
  }

  // --- взгляд администратора --------------------------------------------

  return (
    <>

      <p className="sub">Что подключено и кто имеет доступ.</p>

      <SectionTitle>Состояние</SectionTitle>
      <div className="settings-grid">
        <Card className="setting">
          <b>Twitch API</b>
          {status?.available ? (
            <Pill tone="ok">Подключён</Pill>
          ) : (
            <Pill tone="bad">Не настроен</Pill>
          )}
          <span className="muted">
            {status?.available
              ? "Поиск стримеров, статус эфира, аватарки и обложки игр"
              : status?.note ?? "Нужны ключи в .env"}
          </span>
        </Card>

        <Operations />

        <Card className="setting">
          <b>Публикация</b>
          {youtubeStatus && <p role="status">{youtubeStatus.state === "ok" ? `Доступ работает: ${youtubeStatus.channel}` : youtubeStatus.reason}</p>}
          {platformsState === "loading" ? <p role="status">Загружаю подключение…</p> : platformsState === "error" ? <>
            <p role="alert">Не удалось загрузить сведения о канале. Подключение пока не проверено.</p>
            <Button size="sm" onClick={() => void loadPlatforms()}>Повторить</Button>
          </> : <>
          {platforms.length > 0 && <>
            <Button size="sm" busy={busy === "youtube-check"} onClick={async()=>{
              setBusy("youtube-check");
              try {setYoutubeStatus(await api.post("/api/platforms/youtube/check")); await loadPlatforms();}
              catch {setYoutubeStatus({state:"error",reason:"Проверка не завершилась. Повторите попытку."});}
              finally {setBusy("");}
            }}>Проверить доступ</Button>
            <Button size="sm" busy={busy === "youtube"} onClick={connectYoutube}>Переподключить YouTube</Button>
          </>}
          {platforms.length > 0 ? (
            <Pill tone={platforms[0]!.disconnectRequestedAt?"warn":"ok"}>{platforms[0]!.disconnectRequestedAt?"Отключение…":`YouTube: ${platforms[0]!.label}`}</Pill>
          ) : (
            <Pill>Не подключена</Pill>
          )}
          <span className="muted">
            {platforms.length > 0
              ? "Подключение сохранено. Проверьте действительность доступа. По умолчанию загрузка приватная; публичность ограничена аудитом Google."
              : "Подключите YouTube-канал — появится кнопка публикации у клипов."}
          </span>
          {platforms.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              busy={busy === `off:${platforms[0]!.id}`}
              onClick={() => disconnectPlatform(platforms[0]!.id)}
            >
              Отключить и удалить данные канала
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              busy={busy === "youtube"}
              onClick={connectYoutube}
            >
              Подключить YouTube
            </Button>
          )}
          {platforms.length>0&&<p className="muted">Отключение отзывает доступ Google и удаляет сведения о канале и статистику из ClipForge. Видео на YouTube сохраняются.</p>}
          </>}
        </Card>

        <Card className="setting">
          <b>Число клипов</b>
          <Pill tone="ok">По числу моментов</Pill>
          <span className="muted">
            Автоматика использует бюджет клипов на эфир. При ручном запуске без лимита обрабатываются все найденные моменты.
          </span>
        </Card>
      </div>

      <SectionTitle>Обслуживание</SectionTitle>
      <Card>
        <p className="muted" style={{ marginTop: 0 }}>
          Разовые действия по данным площадки.
        </p>
        <div className="form-row">
          <Button
            busy={busy === "games"}
            disabled={!status?.available}
            onClick={() =>
              run("games", () => api.post("/api/discovery/refresh-games"),
                  "Обложки игр обновлены")
            }
          >
            Добрать обложки игр
          </Button>
          <Button
            busy={busy === "live"}
            disabled={!status?.available}
            onClick={() =>
              run("live", () => api.post("/api/discovery/refresh-live"),
                  "Статус эфиров обновлён")
            }
          >
            Обновить статус эфиров
          </Button>
        </div>
      </Card>

      <AccountSettings viewer={viewer} />

      <SectionTitle>Подключённые каналы</SectionTitle>
      <div className="grid cards">
        {streamers.map((streamer) => (
          <Link className="card" key={streamer.login} href={`/streamers/${streamer.login}`}>
            <h3>{streamer.displayName ?? streamer.login}</h3>
            <div className="meta">
              {streamer.vods} эфиров · {streamer.clips} клипов
            </div>
            <div className="pillrow">
              <Pill tone={streamer.state === "active" ? "ok" : ""}>
                {streamer.state === "active"
                  ? "Автоматика включена"
                  : streamer.state === "paused"
                    ? "На паузе"
                    : "Не подключён"}
              </Pill>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
