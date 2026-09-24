"use client";
import { useEffect, useState } from "react";
import { api, type Viewer } from "@/lib/api";
import { Select } from "./Select";
import { Button, Card, SectionTitle } from "./ui";
import { toast } from "@/lib/toast";
import { useSession } from "@/lib/session";

const roles = { admin: "Администратор", moderator: "Модератор", user: "Пользователь" };
const roleOptions = Object.entries(roles).map(([value,label])=>({value:value as keyof typeof roles,label}));
type Account = {id:string; login:string; displayName:string; role:keyof typeof roles; streamer:string|null};
export function AccountSettings({viewer}:{viewer:Viewer}) {
  const { updateViewer } = useSession();
  const [accounts,setAccounts] = useState<Account[]>([]);
  const [name,setName] = useState(viewer.displayName);
  const [current,setCurrent] = useState("");
  const [password,setPassword] = useState("");
  const [login,setLogin] = useState("");
  const [newPassword,setNewPassword] = useState("");
  const [role,setRole] = useState<keyof typeof roles>("user");
  const [busy,setBusy] = useState(false);
  const load = () => { if(viewer.isAdmin) void api.get<Account[]>("/api/auth/accounts").then(setAccounts).catch(e=>toast.error(String(e))); };
  useEffect(load,[viewer.isAdmin]);
  const action = async(fn:()=>Promise<unknown>) => {setBusy(true);try{await fn();toast.info("Сохранено");load();}catch(e){toast.error(String(e));}finally{setBusy(false);}};
  return <>
    <SectionTitle>Мой аккаунт</SectionTitle>
    <Card><p>{viewer.login} · {roles[viewer.role]}</p>
      <div className="form-row"><input className="field" aria-label="Отображаемое имя" value={name} onChange={e=>setName(e.target.value)}/>
        <Button busy={busy} onClick={()=>action(async()=>{await api.post("/api/auth/profile",{displayName:name});updateViewer({...viewer,displayName:name.trim()});})}>Сохранить имя</Button></div>
      <div className="form-row"><input className="field" type="password" autoComplete="current-password" placeholder="Текущий пароль" value={current} onChange={e=>setCurrent(e.target.value)}/>
        <input className="field" type="password" autoComplete="new-password" placeholder="Новый пароль (от 8 символов)" value={password} onChange={e=>setPassword(e.target.value)}/>
        <Button busy={busy} disabled={!current||password.length<8} onClick={()=>action(async()=>{await api.post("/api/auth/password",{current,password});window.location.href="/login";})}>Изменить пароль</Button></div>
      {viewer.role === "user" && <><p>Twitch: {viewer.actingAs === "__unlinked_account__" ? "Не подключён" : viewer.actingAs}</p>
        <Button onClick={()=>action(async()=>{const r=await api.post<{url:string}>("/api/twitch/connect");window.location.href=r.url;})}>Подтвердить свой Twitch</Button></>}
    </Card>
    {viewer.isAdmin && <><SectionTitle>Аккаунты · регистрация закрыта</SectionTitle>
      <Card><div className="form-row"><input className="field" placeholder="Логин нового аккаунта" value={login} onChange={e=>setLogin(e.target.value)}/>
        <input className="field" type="password" autoComplete="new-password" placeholder="Пароль (от 8 символов)" value={newPassword} onChange={e=>setNewPassword(e.target.value)}/>
        <Select label="Роль нового аккаунта" value={role} onValueChange={setRole} options={roleOptions}/>
        <Button busy={busy} disabled={login.length<3||newPassword.length<8} onClick={()=>action(async()=>{await api.post("/api/auth/accounts",{login,password:newPassword,role});setLogin("");setNewPassword("");})}>Создать</Button>
      </div><p className="muted">Пользователю не нужен канал при создании аккаунта. Он подтвердит Twitch в своём профиле.</p></Card>
      {accounts.map(account=><AccountRow key={account.id} account={account} save={action}/>)}
    </>}
  </>;
}
function AccountRow({account,save}:{account:Account;save:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const [role,setRole]=useState(account.role);
  const [name,setName]=useState(account.displayName??account.login);
  const [channel,setChannel]=useState(account.streamer??"");
  const [password,setPassword]=useState("");
  return <Card><b>{account.login}</b><div className="form-row">
    <input className="field" aria-label={`Имя ${account.login}`} value={name} onChange={e=>setName(e.target.value)}/>
    <Select label={`Роль ${account.login}`} value={role} onValueChange={setRole} options={roleOptions}/>
    <input className="field" aria-label={`Twitch ${account.login}`} placeholder="Twitch-канал пользователя" value={channel} onChange={e=>setChannel(e.target.value)}/>
    <Button onClick={()=>save(()=>api.post(`/api/auth/accounts/${account.id}`,{displayName:name,role,streamer:channel||null}))}>Сохранить</Button>
    <input className="field" type="password" autoComplete="new-password" placeholder="Новый пароль" value={password} onChange={e=>setPassword(e.target.value)}/>
    <Button disabled={password.length<8} onClick={()=>save(async()=>{await api.post(`/api/auth/accounts/${account.id}/password`,{password});setPassword("");})}>Сбросить пароль</Button>
  </div></Card>;
}
