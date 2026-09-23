"use client";

/** Все клипы с фильтрами. */
import { useCallback, useState } from "react";

import { Select } from "@/components/Select";
import { ClipGrid } from "@/components/ClipGrid";
import { api, TRIGGERS, type ClipRow } from "@/lib/api";
import { useLiveReload } from "@/lib/jobs";

export default function ClipsPage() {
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [trigger, setTrigger] = useState("");
  const [state, setState] = useState("");

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: "200" });
    if (trigger) params.set("trigger", trigger);
    if (state) params.set("state", state);
    void api.get<ClipRow[]>(`/api/clips?${params}`).then(setClips);
  }, [trigger, state]);

  // Новые клипы появляются в списке по мере рендера.
  useLiveReload(load);

  return (
    <>
      <h1>Клипы</h1>
      <p className="sub">{clips.length} последних</p>

      <div className="actions">
        <Select label="Тип момента" value={trigger} onValueChange={setTrigger} options={[{value:"",label:"Все триггеры"},...Object.entries(TRIGGERS).map(([value,label])=>({value,label}))]}/>
        <Select label="Состояние клипа" value={state} onValueChange={setState} options={[{value:"",label:"Любое состояние"},{value:"draft",label:"Черновик"},{value:"ready",label:"Одобрен"},{value:"blocked",label:"Снят"}]}/>
      </div>

      <ClipGrid clips={clips} onChange={load} />
    </>
  );
}
