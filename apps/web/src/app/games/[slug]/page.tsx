"use client";

/**
 * Страница игры.
 *
 * Внутри игры интересен разрез по стримеру: «что нарезано у этого канала
 * в этой игре». Поэтому стримеры здесь - фильтр, а не только ссылки:
 * выбор сужает и эфиры, и клипы, не уводя со страницы. Переход к самому
 * каналу остаётся отдельной ссылкой.
 */
import Link from "next/link";
import { NavigationRow } from "@/components/NavigationRow";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { ClipGrid } from "@/components/ClipGrid";
import { Card, PageSkeleton, Pill, SectionTitle } from "@/components/ui";
import {
  api, hhmm, VOD_STATE,
  type ClipRow, type GameRow, type StreamerRow, type VodRow,
} from "@/lib/api";
import { useLiveReload } from "@/lib/jobs";

export default function GamePage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const [game, setGame] = useState<GameRow | null>(null);
  const [streamers, setStreamers] = useState<StreamerRow[]>([]);
  const [vods, setVods] = useState<VodRow[]>([]);
  const [clips, setClips] = useState<ClipRow[]>([]);
  /** null - все стримеры; логин - только его эфиры и клипы. */
  const [who, setWho] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .get<GameRow[]>("/api/games")
      .then((list) => setGame(list.find((g) => g.slug === slug) ?? null));
    void api.get<StreamerRow[]>(`/api/streamers?game=${slug}`).then(setStreamers);
    void api.get<VodRow[]>(`/api/vods?game=${slug}`).then(setVods);
    void api.get<ClipRow[]>(`/api/clips?game=${slug}&limit=60`).then(setClips);
  }, [slug]);

  useLiveReload(load);

  if (!game) return <PageSkeleton />;

  const shownVods = who ? vods.filter((vod) => vod.streamer === who) : vods;
  const shownClips = who ? clips.filter((clip) => clip.streamer === who) : clips;

  return (
    <>
      <div className="crumbs">
        <Link href="/">Обзор</Link>
        <span>/</span>
        <b>{game.title}</b>
      </div>

      <h2 className="detail-title">{game.title}</h2>
      <p className="sub">
        {game.streamers} стримеров · {game.vods} эфиров · {game.clips} клипов
      </p>

      <SectionTitle>Стримеры</SectionTitle>
      <div className="grid cards">
        {streamers.map((streamer) => (
          <Card
            key={streamer.login}
            className={`card selectable${who === streamer.login ? " selected" : ""}`}
          >
            <button
              className="card-filter"
              onClick={() =>
                setWho((current) => (current === streamer.login ? null : streamer.login))
              }
            >
              <h3>{streamer.displayName ?? streamer.login}</h3>
              <div className="meta">
                {streamer.vods} эфиров · {streamer.clips} клипов
              </div>
            </button>
            <div className="pillrow">
              {streamer.live && <Pill tone="bad">В эфире</Pill>}
              <Link className="pill" href={`/streamers/${streamer.login}`}>
                На страницу канала →
              </Link>
            </div>
          </Card>
        ))}
      </div>

      <SectionTitle>Эфиры</SectionTitle>
      {shownVods.length === 0 ? (
        <Card className="empty">Эфиров с этим фильтром нет.</Card>
      ) : (
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Стример</th>
                <th>Название</th>
                <th className="num">Длина</th>
                <th>Состояние</th>
                <th className="num">Клипов</th>
              </tr>
            </thead>
            <tbody>
              {shownVods.map((vod) => {
                const [label, tone] = VOD_STATE[vod.state] ?? [vod.state, ""];
                return (
                  <NavigationRow key={vod.id} href={`/vods/${vod.id}`} label={vod.id}>
                    <td onClick={(event) => event.stopPropagation()}>
                      <Link href={`/streamers/${vod.streamer}`}>{vod.streamer}</Link>
                    </td>
                    <td>{vod.title ?? "—"}</td>
                    <td className="num">{hhmm(vod.duration)}</td>
                    <td>
                      <Pill tone={tone as "" | "ok" | "bad" | "warn"}>{label}</Pill>
                    </td>
                    <td className="num">{vod.clips}</td>
                  </NavigationRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Клипы</SectionTitle>
      <ClipGrid clips={shownClips} onChange={load} />
    </>
  );
}
