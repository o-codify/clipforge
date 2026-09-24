"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type PlatformAccount } from "@/lib/api";
import { Button } from "./ui";
import { Select } from "./Select";
import { displayTranscript } from "@clipforge/contracts/text";

interface Draft { title:string; description:string; privacy:"private"|"unlisted"|"public"; accounts:PlatformAccount[] }

/** Mounted only in the administrator's clip view. */
export function PublishForm({clipId,onDone,onCancel}:{clipId:string;onDone:()=>void;onCancel:()=>void}) {
  const [draft,setDraft]=useState<Draft|null>(null);
  const [accountId,setAccountId]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{
    let active=true;
    void api.get<Draft>(`/api/platforms/publish/${clipId}`).then(value=>{
      if(active){setDraft(value);setAccountId(value.accounts[0]?.id??"");}
    }).catch(e=>{if(active)setError(String(e));});
    return()=>{active=false;};
  },[clipId]);
  return <form className="publish-form" onSubmit={async event=>{
    event.preventDefault();if(!draft||!accountId||busy)return;
    setBusy(true);setError("");
    try { await api.post(`/api/platforms/publish/${clipId}`,{accountId,title:draft.title,description:draft.description,privacy:draft.privacy});onDone(); }
    catch(e){setError(String(e));}finally{setBusy(false);}
  }}>
    <h3>Публикация на YouTube</h3>
    {error&&<p role="alert" className="error">{error}</p>}
    {!draft&&!error&&<p role="status">Загружаю настройки…</p>}
    {draft&&(draft.accounts.length?<>
      <div className="publish-field"><span>Канал</span><Select label="Канал YouTube" value={accountId} onValueChange={setAccountId} disabled={busy}
        options={draft.accounts.map(account=>({value:account.id,label:account.label}))}/></div>
      <label className="publish-field">Название
        <input className="field" value={draft.title} required disabled={busy} onChange={event=>setDraft({...draft,title:event.target.value})} onBlur={()=>setDraft({...draft,title:displayTranscript(draft.title)})}/>
        <small>{[...draft.title].length} / 100 символов</small>
      </label>
      <label className="publish-field">Описание
        <textarea className="field" rows={5} value={draft.description} disabled={busy} onChange={event=>setDraft({...draft,description:event.target.value})} onBlur={()=>setDraft({...draft,description:draft.description.split(/\r?\n/).map(displayTranscript).join("\n")})}/>
      </label>
      <div className="publish-field"><span>Видимость</span><Select<Draft["privacy"]> label="Видимость видео" value={draft.privacy} onValueChange={privacy=>setDraft({...draft,privacy})} disabled={busy}
        options={[{value:"private",label:"Приватно"},{value:"unlisted",label:"По ссылке"},{value:"public",label:"Публично"}]}/></div>
      <p className="muted">Эти название, описание и настройки будут отправлены на YouTube вместе с клипом. Фактическую видимость покажу после обработки видео.</p>
      <Button type="submit" variant="primary" busy={busy} disabled={!accountId}>Отправить на YouTube</Button>
    </>:<p>Сначала <Link href="/me">подключите канал в управлении</Link>.</p>)}
    <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Отмена</Button>
  </form>;
}
