"use client";

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
import { api, type PlatformAccount, type StreamerRow, type Viewer } from "@/lib/api";
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
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [streamers, setStreamers] = useState<StreamerRow[]>([]);
  const [busy, setBusy] = useState("");
  const [youtubeStatus,setYoutubeStatus] = useState<{state:string;reason?:string;channel?:string}|null>(null);
  const [platforms, setPlatforms] = useState<PlatformAccount[]>([]);

  const loadPlatforms = () =>
    api.get<PlatformAccount[]>("/api/platforms").then(setPlatforms).catch(() => {});

  useEffect(() => {
    void api.get<{ viewer: Viewer }>("/api/auth/me").then((r) => setViewer(r.viewer));
    void api.get<Summary>("/api/summary").then(setSummary);
    void api.get<StreamerRow[]>("/api/streamers").then(setStreamers);
    void api
      .get<DiscoveryStatus>("/api/discovery/status")
      .then(setStatus)
      .catch(() => setStatus(null));
    void loadPlatforms();

    // Возврат с согласия Google: результат приходит параметром адреса.
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("youtube") ?? params.get("twitch");
    if (outcome) {
      window.history.replaceState(null, "", window.location.pathname);
      if (outcome === "connected") toast.info("Канал подключён");
      else toast.error("Подключить канал не удалось: проверьте настройки приложения и принадлежность канала");
    }
  }, []);

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
      await api.del(`/api/platforms/${id}`);
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

  if (viewer.role === "moderator") return <><h1>Профиль модератора</h1><AccountSettings viewer={viewer}/><Operations/><p>Доступны каталог, клипы и журнал заданий для поддержки пользователей. Изменение чужих аккаунтов и запуск обработки доступны администратору.</p></>;

  if (!viewer.isAdmin) {
    const mine = streamers[0];
    return (
      <>
        <h1>Мой профиль</h1>
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
      <h1>Настройки площадки</h1>
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
          <Button size="sm" onClick={async()=>{try {setYoutubeStatus(await api.post("/api/platforms/youtube/check"));}catch(e){toast.error(String(e));}}}>Проверить доступ</Button>
          <Button size="sm" busy={busy === "youtube"} onClick={connectYoutube}>Переподключить YouTube</Button>
          {platforms.length > 0 ? (
            <Pill tone="ok">YouTube: {platforms[0]!.label}</Pill>
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
              Отключить
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
