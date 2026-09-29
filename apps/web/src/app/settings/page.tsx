"use client";
import { Operations } from "@/components/Operations";
import { SettingsCard, LoadError } from "@/components/SettingsCard";
import { useCatalog } from "@/lib/catalog-cache";
export default function PlatformPage(){
  const {data:status,error,refresh}=useCatalog<{available:boolean}>("/api/discovery/status");
  return <div className="settings-grid platform-settings"><Operations/><SettingsCard title="Каталог Twitch" status={error?"Не удалось проверить":!status?"Проверка…":status.available?"Настроен":"Не настроен"} tone={error?"bad":status?.available?"ok":""}>
    {error&&<LoadError message="Не удалось загрузить состояние Twitch" retry={refresh}/>}
  </SettingsCard></div>;
}
