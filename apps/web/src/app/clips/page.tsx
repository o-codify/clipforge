"use client";

/** Все клипы с фильтрами. */
import { useState } from "react";

import { Select } from "@/components/Select";
import { ClipGrid } from "@/components/ClipGrid";
import { PageSkeleton } from "@/components/ui";
import { PageScroll } from "@/components/PageScroll";
import { TRIGGERS, type ClipRow } from "@/lib/api";
import { useCatalog } from "@/lib/catalog-cache";
import { counted } from "@/lib/number";

export default function ClipsPage() {
  const [trigger, setTrigger] = useState("");
  const [state, setState] = useState("");
  const params = new URLSearchParams({ limit: "200" });
  if (trigger) params.set("trigger", trigger);
  if (state) params.set("state", state);
  const { data: clips, loading, error, refresh } = useCatalog<ClipRow[]>(`/api/clips?${params}`);

  return (
    <>
      <div className="page-toolbar">
        <Select label="Тип момента" value={trigger} onValueChange={setTrigger} options={[{value:"",label:"Все моменты"},...Object.entries(TRIGGERS).map(([value,label])=>({value,label}))]}/>
        <Select label="Состояние клипа" value={state} onValueChange={setState} options={[{value:"",label:"Любое состояние"},{value:"draft",label:"Черновик"},{value:"ready",label:"Одобрен"},{value:"blocked",label:"Снят"}]}/>
        <span className="toolbar-count">{clips ? counted(clips.length, "клип", "клипа", "клипов") : "…"}</span>
      </div>

      <PageScroll>
      {error && <p role="alert">{error} <button className="btn" onClick={refresh}>Повторить</button></p>}
      {loading && <PageSkeleton />}
      {clips && <ClipGrid clips={clips} onChange={refresh} />}
      </PageScroll>
    </>
  );
}
