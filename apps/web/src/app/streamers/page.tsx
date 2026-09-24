"use client";
import { useSession } from "@/lib/session";
import Link from "next/link";
import { useCallback, useState } from "react";
import { api, type StreamerRow } from "@/lib/api";
import { useLiveReload } from "@/lib/jobs";
export default function StreamersPage(){
  const { viewer } = useSession(); const admin = viewer.isAdmin;
  const [rows,setRows]=useState<StreamerRow[]>([]);const [query,setQuery]=useState("");const [error,setError]=useState("");
  const load=useCallback(()=>{void api.get<StreamerRow[]>("/api/streamers").then(rows=>{setRows(rows);setError("");}).catch(()=>setError("Не удалось загрузить стримеров"));},[]);useLiveReload(load);
  return <><p className="sub">Каналы, с которыми работает платформа.</p><div className="form-row"><input className="input" aria-label="Найти стримера" placeholder="Имя стримера" value={query} onChange={e=>setQuery(e.target.value)}/>{admin&&<Link className="btn" href="/discovery">Поиск новых каналов</Link>}</div>{error&&<p role="alert">{error}</p>}<div className="catalog-grid">{rows.filter(row=>`${row.login} ${row.displayName}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(row=><Link className="card catalog-entry" href={`/streamers/${row.login}`} key={row.login}>{row.avatar&&<img src={row.avatar} alt=""/>}<div><b>{row.displayName??row.login}</b><p className="sub">{row.live?"Сейчас в эфире":"Записи эфиров"} · {row.clips} клипов</p></div></Link>)}</div>{!rows.length&&!error&&<p>Пока нет доступных каналов.</p>}</>;
}
