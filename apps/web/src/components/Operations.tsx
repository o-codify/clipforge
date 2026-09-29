"use client";
import { useSession } from "@/lib/session";
import { useCallback, useState } from "react";
import { api, when } from "@/lib/api";
import { useLiveReload } from "@/lib/jobs";
import { Button } from "./ui";
import { SettingsCard, LoadError } from "./SettingsCard";
import { toast } from "@/lib/toast";
export function Operations({compact=false}:{compact?:boolean}) {
  const [status,setStatus]=useState<any>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const {viewer}=useSession();
  const load=useCallback(()=>{void api.get("/api/operations").then(s=>{setStatus(s);setError("");}).catch(()=>setError("Не удалось загрузить состояние платформы"));},[]);
  useLiveReload(load);
  const paused=!!status?.runtime?.settings?.paused, development=!!status?.runtime?.settings?.developmentMode;
  const pause=async()=>{setBusy(true);try{await api.post("/api/operations/pause",{paused:!paused});load();}catch(e){toast.error(String(e));}finally{setBusy(false);}};
  if(error)return <LoadError message={error} retry={load}/>;
  const processing=<SettingsCard title="Обработка видео" status={!status?"Проверка…":status.online?"Доступна":"Недоступна"} tone={!status?"":status.online?"ok":"bad"} actions={viewer.isAdmin&&status?<Button busy={busy} onClick={pause}>{paused?"Возобновить новые задания":"Приостановить новые задания"}</Button>:undefined}>
    <dl className="settings-facts"><div><dt>Новые задания</dt><dd>{!status?"—":paused?"На паузе":"Разрешены"}</dd></div><div><dt>Последняя связь</dt><dd>{when(status?.runtime?.worker?.updatedAt)}</dd></div></dl>
  </SettingsCard>;
  if(compact)return processing;
  return <>{processing}<SettingsCard title="Автоматическая нарезка" status={!status?"Проверка…":development?"Выключена":paused?"На паузе":!status.online?"Ожидает обработчик":"Включена"} tone={!status||development?"":paused||!status.online?"warn":"ok"}>
    <dl className="settings-facts"><div><dt>Режим</dt><dd>{!status?"—":development?"Ручной запуск":"Автоматический"}</dd></div><div><dt>Последний выбор эфира</dt><dd>{when(status?.runtime?.scheduler?.updatedAt)}</dd></div></dl>
  </SettingsCard><SettingsCard title="Автопубликация" status={!status?"Проверка…":!status.autoPublishEnabled?"Выключена":paused?"На паузе":"Включена"} tone={status?.autoPublishEnabled?(paused?"warn":"ok"):""}>
    <dl className="settings-facts"><div><dt>Отправка клипов</dt><dd>{!status?"—":status.autoPublishEnabled?"Автоматически":"Вручную"}</dd></div><div><dt>Последнее обновление статистики</dt><dd>{when(status?.runtime?.metrics?.updatedAt)}</dd></div></dl>
  </SettingsCard></>;
}
