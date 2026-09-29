"use client";
import { StreamerBadge } from "@/components/StreamerBadge";

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
import { useParams } from "next/navigation";
import { useState } from "react";

import { ClipGrid } from "@/components/ClipGrid";
import { Card, PageSkeleton, Pill, SectionTitle } from "@/components/ui";
import {
  hhmm, VOD_STATE,
  type ClipRow, type GameRow, type StreamerRow, type VodRow,
} from "@/lib/api";
import { useCatalog } from "@/lib/catalog-cache";
import { useSession } from "@/lib/session";
import { counted } from "@/lib/number";
import { Select } from "@/components/Select";
import { DetailPage } from "@/components/DetailPage";

export default function GamePage() {
  const { slug } = useParams<{ slug: string }>();
  const {viewer}=useSession();
  const catalog=useCatalog<GameRow[]>("/api/games");
  const game=catalog.data?.find(item=>item.slug===slug);
  const streamerData=useCatalog<StreamerRow[]>(`/api/streamers?game=${encodeURIComponent(slug)}`,!!game);
  const vodData=useCatalog<VodRow[]>(`/api/vods?game=${encodeURIComponent(slug)}`,!!game);
  const clipData=useCatalog<ClipRow[]>(`/api/clips?game=${encodeURIComponent(slug)}&limit=60`,!!game);
  const streamers=streamerData.data??[];
  const vods=vodData.data??[];
  const clips=clipData.data??[];
  /** null - все стримеры; логин - только его эфиры и клипы. */
  const [who, setWho] = useState<string | null>(null);

  if (catalog.loading) return <PageSkeleton />;
  if (!game) return <Card className="empty">{catalog.error?<><p role="alert">Не удалось загрузить игру</p><button className="btn" onClick={catalog.refresh}>Повторить</button></>:<>Игра недоступна. <Link href="/games">Все игры</Link></>}</Card>;

  const shownVods = who ? vods.filter((vod) => vod.streamer === who) : vods;
  const shownClips = who ? clips.filter((clip) => clip.streamer === who) : clips;

  return (
    <DetailPage intro={<>
      <div className="crumbs">
        <Link href="/">Обзор</Link>
        <span>/</span>
        <b>{game.title}</b>
      </div>

      <h2 className="detail-title">{game.title}</h2>
      <p className="sub">
        {viewer.role!=="user"&&`${counted(game.streamers,"стример","стримера","стримеров")} · `}{counted(game.vods,"эфир","эфира","эфиров")} · {counted(game.clips,"клип","клипа","клипов")}
      </p>

    </>} toolbar={viewer.role!=="user"&&<><Select label="Стример" value={who??""} onValueChange={value=>setWho(value||null)} options={[{value:"",label:"Все стримеры"},...streamers.map(streamer=>({value:streamer.login,label:streamer.displayName??streamer.login,content:<StreamerBadge login={streamer.login} name={streamer.displayName} avatar={streamer.avatar} linked={false}/>}))]} disabled={streamerData.loading}/>{who&&<Link className="btn" href={`/streamers/${who}`}>На страницу канала</Link>}{streamerData.error&&<span role="alert">Не удалось загрузить стримеров</span>}</>}>

      <SectionTitle>Эфиры</SectionTitle>
      {vodData.error&&<p role="alert">Не удалось обновить эфиры. <button className="btn" onClick={vodData.refresh}>Повторить</button></p>}
      {vodData.loading ? <p role="status">Загрузка эфиров…</p> : !vodData.error&&shownVods.length === 0 ? (
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
                      <StreamerBadge login={vod.streamer}/>
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
      {clipData.error&&<p role="alert">Не удалось обновить клипы. <button className="btn" onClick={clipData.refresh}>Повторить</button></p>}
      {clipData.loading?<p role="status">Загрузка клипов…</p>:<ClipGrid clips={shownClips} onChange={clipData.refresh} />}
    </DetailPage>
  );
}
