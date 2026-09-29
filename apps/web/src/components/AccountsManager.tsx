"use client";
import { useEffect, useState } from "react";
import { api, when, type StreamerRow } from "@/lib/api";
import { useCatalog } from "@/lib/catalog-cache";
import { useSession } from "@/lib/session";
import { Select } from "./Select";
import { Button, Pill } from "./ui";
import { Modal } from "./Modal";
import { PageScroll } from "./PageScroll";
import { LoadError } from "./SettingsCard";
import { StreamerBadge } from "./StreamerBadge";
import { toast } from "@/lib/toast";
const roles={admin:"Администратор",moderator:"Модератор",user:"Пользователь"};
const roleOptions=Object.entries(roles).map(([value,label])=>({value:value as keyof typeof roles,label}));
type Account={id:string;login:string;displayName:string;role:keyof typeof roles;streamer:string|null;lastSeen?:string|null};
type Editor={mode:"create"}|{mode:"edit"|"password";account:Account};
function generatePassword(){
  const alphabet="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const result:string[]=[];
  while(result.length<20){const values=crypto.getRandomValues(new Uint8Array(32));for(const value of values){if(value<Math.floor(256/alphabet.length)*alphabet.length)result.push(alphabet[value%alphabet.length]!);if(result.length===20)break;}}
  return result.join("");
}
function PasswordField({value,onChange,disabled=false}:{value:string;onChange:(value:string)=>void;disabled?:boolean}){
  const [visible,setVisible]=useState(false);
  return <div className="password-editor"><label>Пароль<input className="field" type={visible?"text":"password"} autoComplete="new-password" required minLength={8} maxLength={200} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}/><small>От 8 до 200 символов</small></label>
    <div className="password-actions"><Button type="button" disabled={disabled} onClick={()=>{onChange(generatePassword());setVisible(true);}}>Сгенерировать</Button><Button type="button" disabled={disabled||!value} onClick={()=>setVisible(old=>!old)}>{visible?"Скрыть":"Показать"}</Button><Button type="button" disabled={disabled||!value} onClick={()=>void navigator.clipboard.writeText(value).then(()=>toast.info("Пароль скопирован")).catch(()=>toast.error("Не удалось скопировать пароль"))}>Копировать</Button></div>
  </div>;
}
export function AccountsManager(){
  const [accounts,setAccounts]=useState<Account[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [query,setQuery]=useState(""),[filter,setFilter]=useState(""),[editor,setEditor]=useState<Editor|null>(null);
  const load=async()=>{try{setAccounts(await api.get<Account[]>("/api/auth/accounts"));setError("");}catch{setError("Не удалось загрузить аккаунты");}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const rows=accounts.filter(account=>(!filter||account.role===filter)&&(account.login+" "+account.displayName).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <><div className="page-toolbar account-toolbar"><input className="field toolbar-search" aria-label="Найти пользователя" placeholder="Имя или логин" value={query} onChange={e=>setQuery(e.target.value)}/><Select label="Роль пользователя" value={filter} onValueChange={setFilter} options={[{value:"",label:"Все роли"},...roleOptions]}/><span className="toolbar-count" aria-label="Найдено пользователей">{rows.length}</span><Button variant="primary" onClick={()=>setEditor({mode:"create"})}>Создать пользователя</Button></div>
    <PageScroll>
    {error&&<LoadError message={error} retry={()=>void load()}/>} {loading&&<p role="status">Загрузка пользователей…</p>}
    {!loading&&<div className="scroller accounts-table"><table><thead><tr><th>Пользователь</th><th>Роль</th><th>Канал Twitch</th><th>Последний вход</th><th>Действия</th></tr></thead><tbody>{rows.map(account=><tr key={account.id}><td><div className="account-identity"><span className="account-avatar" aria-hidden>{(account.displayName||account.login).slice(0,1).toUpperCase()}</span><span><b>{account.displayName||account.login}</b><small>{account.login}</small></span></div></td><td><Pill>{roles[account.role]}</Pill></td><td>{account.streamer?<StreamerBadge login={account.streamer}/>:<span className="muted">Не связан</span>}</td><td>{when(account.lastSeen)}</td><td><div className="row-actions"><Button size="sm" onClick={()=>setEditor({mode:"edit",account})}>Редактировать</Button><Button size="sm" onClick={()=>setEditor({mode:"password",account})}>Сменить пароль</Button></div></td></tr>)}</tbody></table>{!rows.length&&<div className="empty">Пользователи не найдены</div>}</div>}
    </PageScroll>{editor&&<AccountEditor editor={editor} lastAdmin={accounts.filter(account=>account.role==="admin").length===1} onClose={()=>setEditor(null)} saved={()=>{setEditor(null);void load();}}/>}
  </>;
}
function AccountEditor({editor,lastAdmin,onClose,saved}:{editor:Editor;lastAdmin:boolean;onClose:()=>void;saved:()=>void}){
  const account=editor.mode==="create"?null:editor.account;
  const {viewer,updateViewer}=useSession();
  const [login,setLogin]=useState(account?.login??""),[name,setName]=useState(account?.displayName??"");
  const [role,setRole]=useState<keyof typeof roles>(account?.role??"user"),[channel,setChannel]=useState(account?.streamer??"");
  const [password,setPassword]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const {data:channels=[]}=useCatalog<StreamerRow[]>("/api/streamers");
  const close=()=>{if(!busy)onClose();};
  const save=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError("");try{
    if(editor.mode==="create")await api.post("/api/auth/accounts",{login:login.trim(),displayName:name.trim()||login.trim(),password,role,streamer:role==="user"?(channel||null):null});
    else if(editor.mode==="password")await api.post("/api/auth/accounts/"+account!.id+"/password",{password});
    else {const patch:{displayName?:string;role?:string;streamer?:string|null}={};if(name.trim()!==account!.displayName)patch.displayName=name.trim();if(role!==account!.role)patch.role=role;const nextChannel=role==="user"?(channel||null):null;if(nextChannel!==account!.streamer)patch.streamer=nextChannel;await api.post("/api/auth/accounts/"+account!.id,patch);if(account!.id===viewer.accountId&&patch.displayName)updateViewer({...viewer,displayName:patch.displayName});}
    toast.info(editor.mode==="create"?"Пользователь создан":editor.mode==="password"?"Пароль изменён":"Изменения сохранены");saved();
  }catch(e){setError(e instanceof Error?e.message:"Не удалось сохранить изменения");}finally{setBusy(false);}};
  return <Modal title={editor.mode==="create"?"Новый пользователь":editor.mode==="password"?"Сменить пароль":"Редактировать пользователя"} onClose={close}>
    <form className="account-editor" onSubmit={e=>void save(e)}>
      {account&&<div className="editor-account"><b>{account.displayName||account.login}</b><span>{account.login}</span></div>}
      {editor.mode!=="password"&&<><div className="editor-fields">
        {editor.mode==="create"&&<label>Логин<input className="field" required minLength={3} maxLength={64} pattern="[A-Za-z0-9_.-]+" autoComplete="off" value={login} disabled={busy} onChange={e=>setLogin(e.target.value)}/><small>3–64 символа: латиница, цифры, точка, дефис, подчёркивание</small></label>}
        <label>Имя<input className="field" required={editor.mode==="edit"} minLength={1} maxLength={100} value={name} disabled={busy} onChange={e=>setName(e.target.value)}/><small>До 100 символов</small></label>
        <label>Роль<Select label="Роль аккаунта" value={role} onValueChange={setRole} options={roleOptions} disabled={busy||!!(account?.role==="admin"&&lastAdmin)}/>{account?.role==="admin"&&lastAdmin&&<small>Последний администратор</small>}</label>
        {role==="user"&&<label>Канал Twitch<Select label="Канал пользователя" value={channel} onValueChange={setChannel} disabled={busy} options={[{value:"",label:"Без канала"},...channels.map(row=>({value:row.login,label:row.displayName??row.login,content:<StreamerBadge login={row.login} name={row.displayName} avatar={row.avatar} linked={false}/>}))]}/></label>}
      </div></>}
      {editor.mode!=="edit"&&<PasswordField value={password} onChange={setPassword} disabled={busy}/>}
      {editor.mode==="password"&&<p className="muted">После смены пароля текущие сессии пользователя завершатся.</p>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><Button type="button" disabled={busy} onClick={close}>Отмена</Button><Button type="submit" variant="primary" busy={busy}>{editor.mode==="create"?"Создать пользователя":editor.mode==="password"?"Сохранить пароль":"Сохранить изменения"}</Button></div>
    </form>
  </Modal>;
}
