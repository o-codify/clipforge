"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, when, type PlatformAccount } from "@/lib/api";
import { Button } from "@/components/ui";
import { SettingsCard, LoadError } from "@/components/SettingsCard";
import { Modal } from "@/components/Modal";
import { toast } from "@/lib/toast";
export default function PublicationSettings(){
  const [platforms,setPlatforms]=useState<PlatformAccount[]|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState("");
  const [checked,setChecked]=useState<Record<string,{state:string;reason?:string}>>({}),[disconnect,setDisconnect]=useState<PlatformAccount|null>(null);
  const router=useRouter();
  const load=async()=>{try{setPlatforms(await api.get<PlatformAccount[]>("/api/platforms"));setError("");}catch{setError("Не удалось загрузить подключения YouTube");}};
  useEffect(()=>{void load();const outcome=new URLSearchParams(window.location.search).get("youtube");if(outcome){if(outcome==="connected")toast.info("Канал подключён");else toast.error("Не удалось подключить канал");router.replace("/settings/publication");}},[router]);
  const action=async(key:string,run:()=>Promise<unknown>)=>{if(busy)return;setBusy(key);try{await run();}catch(e){toast.error(String(e));}finally{setBusy("");}};
  const connect=()=>void action("connect",async()=>{const {url}=await api.post<{url:string}>("/api/platforms/youtube/connect");window.location.assign(url);});
  return <><div className="settings-section-heading"><div><span className="eyebrow">YouTube</span><h2>Каналы публикации</h2></div>{platforms&&platforms.length>0&&<Button variant="primary" busy={busy==="connect"} onClick={connect}>Добавить канал</Button>}</div>
    {error&&<LoadError message={error} retry={()=>void load()}/>}
    {!platforms&&!error&&<div className="settings-empty" role="status">Загрузка каналов…</div>}
    <div className="settings-grid publication-settings">{platforms?.map(platform=><SettingsCard key={platform.id} title={platform.label||"YouTube"} status={platform.disconnectRequestedAt?"Отключение…":checked[platform.id]?.state==="error"?"Нужна проверка":checked[platform.id]?.state==="ok"?"Доступ подтверждён":"Подключение сохранено"} tone={platform.disconnectRequestedAt?"warn":checked[platform.id]?.state==="error"?"bad":checked[platform.id]?.state==="ok"?"ok":""}
      actions={<><Button disabled={!!busy||!!platform.disconnectRequestedAt} busy={busy===platform.id} onClick={()=>void action(platform.id,async()=>{const result=await api.post<{state:string;reason?:string}>("/api/platforms/youtube/check",{accountId:platform.id});setChecked(old=>({...old,[platform.id]:result}));await load();})}>Проверить доступ</Button><Button disabled={!!busy} onClick={connect}>Переподключить</Button><Button variant="danger" disabled={!!busy||!!platform.disconnectRequestedAt} onClick={()=>setDisconnect(platform)}>Отключить</Button></>}>
      <dl className="settings-facts"><div><dt>Площадка</dt><dd>YouTube</dd></div><div><dt>Подключён</dt><dd>{when(platform.createdAt)}</dd></div><div><dt>Последняя проверка</dt><dd>{when(platform.verifiedAt)}</dd></div></dl>
      {checked[platform.id]?.reason&&<p role="status" className="task-error">{checked[platform.id]?.reason}</p>}
      <p>Видимость выбирается перед отправкой клипа. По умолчанию — приватно.</p>
    </SettingsCard>)}</div>
    {platforms?.length===0&&<div className="settings-empty"><span className="service-mark youtube-mark" aria-hidden>▶</span><h2>Каналы пока не подключены</h2><p>Подключите YouTube-канал для отправки готовых клипов.</p><Button variant="primary" busy={busy==="connect"} onClick={connect}>Подключить канал</Button></div>}
    {disconnect&&<Modal title="Отключить канал" onClose={()=>{if(!busy)setDisconnect(null);}}><p>Отключить «{disconnect.label}»? Доступ будет отозван, сведения о канале и его статистика удалены из ClipForge. Видео на YouTube сохранятся.</p><div className="dialog-actions"><Button disabled={!!busy} onClick={()=>setDisconnect(null)}>Отмена</Button><Button variant="danger" busy={busy==="disconnect"} onClick={()=>void action("disconnect",async()=>{const result=await api.del<{state:string}>("/api/platforms/"+disconnect.id);toast.info(result.state==="pending"?"Отключение ожидает ответа Google":"Канал отключён");setDisconnect(null);await load();})}>Отключить канал</Button></div></Modal>}
  </>;
}
