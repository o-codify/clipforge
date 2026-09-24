"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { api, type GameRow } from "@/lib/api";
import { useLiveReload } from "@/lib/jobs";
export default function GamesPage(){
  const [rows,setRows]=useState<GameRow[]>([]);const [query,setQuery]=useState("");const [error,setError]=useState("");
  const load=useCallback(()=>{void api.get<GameRow[]>("/api/games").then(rows=>{setRows(rows);setError("");}).catch(()=>setError("Не удалось загрузить игры"));},[]);useLiveReload(load);
  return <><input className="input" aria-label="Найти игру" placeholder="Название игры или категории" value={query} onChange={e=>setQuery(e.target.value)}/>{error&&<p role="alert">{error}</p>}<div className="catalog-grid">{rows.filter(row=>row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(row=><Link className="card catalog-entry" href={`/games/${row.slug}`} key={row.slug}>{row.boxArt&&<img src={row.boxArt} alt=""/>}<div><b>{row.title}</b><p className="sub">{row.clips} клипов</p></div></Link>)}</div>{!rows.length&&!error&&<p>Пока нет доступных категорий.</p>}</>;
}
