"use client";
import { useState } from "react";
import { api, type Viewer } from "@/lib/api";
import { Button, Card } from "./ui";
import { toast } from "@/lib/toast";
import { useSession } from "@/lib/session";
import { StreamerBadge } from "./StreamerBadge";

export function AccountSettings({viewer}:{viewer:Viewer}) {
  const { updateViewer } = useSession();
  const [name,setName] = useState(viewer.displayName);
  const [current,setCurrent] = useState("");
  const [password,setPassword] = useState("");
  const [busy,setBusy] = useState("");
  const action = async(key:string, fn:()=>Promise<unknown>) => {setBusy(key);try{await fn();toast.info("Сохранено");}catch(e){toast.error(String(e));}finally{setBusy("");}};
  if(viewer.isPreview) return <Card><h2>Профиль стримера</h2><StreamerBadge login={viewer.actingAs!}/><p className="muted">Изменение личных данных недоступно в режиме просмотра.</p></Card>;
  return <div className="profile-settings-grid">
    <Card><h2>Личные данные</h2><form className="settings-form" onSubmit={e=>{e.preventDefault();void action("name",async()=>{await api.post("/api/auth/profile",{displayName:name});updateViewer({...viewer,displayName:name.trim()});});}}>
      <label>Логин<input className="field" value={viewer.login} readOnly autoComplete="username"/></label>
      <label>Имя<input className="field" minLength={1} maxLength={100} required value={name} onChange={e=>setName(e.target.value)}/><small>От 1 до 100 символов</small></label>
      <Button type="submit" busy={busy==="name"} disabled={!name.trim() || name.trim()===viewer.displayName}>Сохранить</Button>
    </form></Card>
    <Card><h2>Пароль</h2><form className="settings-form" onSubmit={e=>{e.preventDefault();void action("password",async()=>{await api.post("/api/auth/password",{current,password});window.location.assign("/login");});}}>
      <label>Текущий пароль<input className="field" type="password" autoComplete="current-password" required maxLength={200} value={current} onChange={e=>setCurrent(e.target.value)}/></label>
      <label>Новый пароль<input className="field" type="password" autoComplete="new-password" required minLength={8} maxLength={200} value={password} onChange={e=>setPassword(e.target.value)}/><small>От 8 до 200 символов</small></label>
      <Button type="submit" busy={busy==="password"} disabled={!current||password.length<8}>Изменить пароль</Button>
    </form></Card>
    {viewer.role==="user"&&<Card><h2>Twitch</h2><p>{!viewer.actingAs||viewer.actingAs==="__unlinked_account__"?"Канал не подключён":<StreamerBadge login={viewer.actingAs} external/>}</p><Button busy={busy==="twitch"} onClick={()=>action("twitch",async()=>{const result=await api.post<{url:string}>("/api/twitch/connect");window.location.assign(result.url);})}>Подтвердить свой Twitch</Button></Card>}
  </div>;
}
