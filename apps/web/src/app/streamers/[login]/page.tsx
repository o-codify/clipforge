"use client";
import { StreamerBadge } from "@/components/StreamerBadge";
import { useSession } from "@/lib/session";

/**
 * Страница стримера.
 *
 * Шапка - один блок: профиль слева, переключатель автоматики справа
 * внутри той же карточки. Отдельной плашки «автоматика включена» нет -
 * состояние читается по самой кнопке, дублировать его словами незачем.
 *
 * Обновление списка эфиров живёт там, где сами эфиры: маленькой
 * кнопкой-иконкой в заголовке таблицы, рядом с датой последнего обхода.
 * Отдельная большая кнопка сверху была шумом.
 */
import Link from "next/link";
import { NavigationRow } from "@/components/NavigationRow";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Button, Card, JobButton, PageSkeleton, Pill, SectionTitle } from "@/components/ui";
import { api, hhmm, VOD_STATE, when, type VodRow } from "@/lib/api";
import { useLiveReload } from "@/lib/jobs";
import { toast } from "@/lib/toast";
import { DetailPage } from "@/components/DetailPage";
import {AdSetting} from '@/components/AdSetting';
import {DraftBatch} from '@/components/DraftBatch';
import {AudioSetting,type AudioMode} from '@/components/AudioSetting';

interface StreamerDetail {
  login: string;
  displayName: string | null;
  avatar: string | null;
  description: string | null;
  followers: number | null;
  state: "candidate" | "active" | "paused";
  autoPublish: boolean;
  audioMode: AudioMode;
  adCheckEnabled:boolean;
  live: boolean;
  liveGame: string | null;
  liveViewers: number | null;
  indexedAt: string | null;
  games: { game: string; title: string | null; seconds: number; streams: number }[];
}

export default function StreamerPage() {
  const { login } = useParams<{ login: string }>();

  const [streamer, setStreamer] = useState<StreamerDetail | null>(null);
  const [vods, setVods] = useState<VodRow[]>([]);
  const [toggling, setToggling] = useState(false);
  const [togglingPublish, setTogglingPublish] = useState(false);
  const { viewer } = useSession(); const isAdmin = viewer.isAdmin;
  /** null - все игры; слуг - только её эфиры. */
  const [gameFilter, setGameFilter] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.get<StreamerDetail>(`/api/streamers/${login}`).then(setStreamer);
    void api.get<VodRow[]>(`/api/vods?streamer=${login}`).then(setVods);
  }, [login]);

  useLiveReload(load);


  const toggleAutomation = async () => {
    if (!streamer) return;
    setToggling(true);
    try {
      await api.post(`/api/streamers/${login}/state`, {
        state: streamer.state === "active" ? "paused" : "active",
      });
      load();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setToggling(false);
    }
  };

  const toggleAutoPublish = async () => {
    if (!streamer) return;
    setTogglingPublish(true);
    try {
      await api.post(`/api/streamers/${login}/auto-publish`, {
        enabled: !streamer.autoPublish,
      });
      load();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setTogglingPublish(false);
    }
  };

  if (!streamer) return <PageSkeleton />;

  const name = streamer.displayName ?? streamer.login;
  const automationOn = streamer.state === "active";
  const shownVods = gameFilter
    ? vods.filter((vod) => vod.game === gameFilter)
    : vods;

  return (
    <DetailPage intro={<>
      <div className="crumbs">
        <Link href="/">Обзор</Link>
        <span>/</span>
        <StreamerBadge login={login} name={name} avatar={streamer.avatar} linked={false}/>
      </div>

      <Card className="profile">
        <div>
          <StreamerBadge login={login} name={name} avatar={streamer.avatar} external/>
          <p className="muted" style={{ margin: 0 }}>
            {streamer.followers
              ? `${streamer.followers.toLocaleString("ru-RU")} фолловеров`
              : ""}
          </p>
          {streamer.live && (
            <p style={{ margin: "8px 0 0" }}>
              {/* Значок как на самом Твиче, и он ведёт на эфир. */}
              <a
                className="live-badge"
                href={`https://twitch.tv/${streamer.login}`}
                target="_blank"
                rel="noopener"
              >
                Live
                <span className="viewers">
                  {streamer.liveGame ?? ""}
                  {streamer.liveViewers
                    ? ` · ${streamer.liveViewers.toLocaleString("ru-RU")} зрителей`
                    : ""}
                </span>
              </a>
            </p>
          )}
        </div>
        <div className="profile-side">
          {/* Кнопки и есть индикаторы состояния. Призраки подписей
              держат ширину: переключение не сдвигает ни пикселя. */}
          {isAdmin && <Button
            variant={automationOn ? "default" : "primary"}
            icon={automationOn ? "❙❙" : "▶"}
            busy={toggling}
            reserve={["Автоматика включена", "Автоматика выключена"]}
            onClick={toggleAutomation}
          >
            {automationOn ? "Автоматика включена" : "Автоматика выключена"}
          </Button>}
          {isAdmin && (
            <Button
              variant="default"
              icon={streamer.autoPublish ? "❙❙" : "▶"}
              busy={togglingPublish}
              reserve={["Автопубликация включена", "Автопубликация выключена"]}
              onClick={toggleAutoPublish}
            >
              {streamer.autoPublish
                ? "Автопубликация включена"
                : "Автопубликация выключена"}
            </Button>
          )}
        </div>
      </Card>

      {isAdmin&&<Card><AudioSetting scope="streamer" id={login} value={streamer.audioMode} onSaved={load}/><AdSetting scope="streamer" id={login} value={streamer.adCheckEnabled} onSaved={load}/></Card>}
      {isAdmin&&<Card><DraftBatch login={login}/></Card>}

      {streamer.games.length > 0 && <SectionTitle>Играет</SectionTitle>}
    </>} toolbar={streamer.games.length > 0 && <>
            {streamer.games.map((game) => (
              <button
                key={game.game}
                className={`pill${gameFilter === game.game ? " on" : ""}`}
                onClick={() =>
                  setGameFilter((current) => (current === game.game ? null : game.game))
                }
              >
                {game.title ?? game.game} · {Math.round(game.seconds / 3600)} ч
              </button>
            ))}
    </>}>

      <SectionTitle
        action={
          isAdmin && <JobButton
            compact
            size="sm"
            target={login}
            kinds={["index-channel"]}
            icon="⟳"
            onRun={() =>
              api.post("/api/jobs/index-channel", {
                login, limit: 20, withChapters: true,
              })
            }
          >
            Обновить список эфиров
          </JobButton>
        }
        aside={
          <span className="muted">
            {gameFilter ? `${shownVods.length} из ${vods.length}` : vods.length} записей
            {streamer.indexedAt ? ` · обновлено ${when(streamer.indexedAt)}` : ""}
          </span>
        }
      >
        Эфиры
      </SectionTitle>

      {shownVods.length === 0 ? (
        <Card className="empty">
          Эфиров пока нет.
        </Card>
      ) : (
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Название</th>
                <th className="num">Длина</th>
                <th>Исходники</th>
                <th className="num">Клипов</th>
                <th className="cell-end" />
              </tr>
            </thead>
            <tbody>
              {shownVods.map((vod) => (
                <VodRowView key={vod.id} vod={vod} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DetailPage>
  );
}

/** Строка эфира. Кликабельна целиком - ведёт на страницу эфира. */
function VodRowView({ vod }: { vod: VodRow }) {
  const router = useRouter();
  const [label, tone] = VOD_STATE[vod.state] ?? [vod.state, ""];

  return (
    <NavigationRow href={`/vods/${vod.id}`} label={vod.id}>
      <td>{vod.title ?? "—"}</td>
      <td className="num">{hhmm(vod.duration)}</td>
      <td>
        <Pill tone={tone as "" | "ok" | "bad" | "warn"}>{label}</Pill>
      </td>
      <td className="num">{vod.clips}</td>
      {/* Кнопка внутри кликабельной строки: клик по ней не должен
          заодно открывать страницу эфира. */}
      <td className="cell-end" onClick={(event) => event.stopPropagation()}>
        <JobButton
          size="sm"
          target={vod.id}
          onRun={() => api.post(`/api/jobs/pipeline/${vod.id}`, {})}
        >
          Нарезать
        </JobButton>
      </td>
    </NavigationRow>
  );
}
