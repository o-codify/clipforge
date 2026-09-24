"use client";

/** Прогон: настройки и все нарезанные клипы. */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";

import { ClipGrid } from "@/components/ClipGrid";
import { PageSkeleton } from "@/components/ui";
import { api, runTime, type ClipRow } from "@/lib/api";
import { useLiveReload } from "@/lib/jobs";

interface RunDetail {
  run: {
    id: string;
    vodId: string;
    streamer: string;
    game: string | null;
    version: string;
    candidates: number;
    outDir: string;
    settings: Record<string, unknown>;
  };
  clips: ClipRow[];
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<RunDetail | null>(null);

  const load = useCallback(() => {
    void api.get<RunDetail>(`/api/runs/${id}`).then(setData);
  }, [id]);
  // Клипы прогона появляются по одному прямо во время рендера.
  useLiveReload(load);

  if (!data) return <PageSkeleton />;
  const { run, clips } = data;

  return (
    <>
      <div className="crumbs">
        <Link href="/">Обзор</Link> /{" "}
        <Link href={`/streamers/${run.streamer}`}>{run.streamer}</Link> /{" "}
        <Link href={`/vods/${run.vodId}`}>Исходный эфир</Link> /{" "}
        <b>{runTime(run.id)}</b>
      </div>

      <h2 className="detail-title">Прогон {runTime(run.id)}</h2>
      <p className="sub">
        {clips.length} клипов из {run.candidates} кандидатов


      </p>

      <ClipGrid clips={clips} onChange={load} />
    </>
  );
}
