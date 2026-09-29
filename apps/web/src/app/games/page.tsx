"use client";
import Link from "next/link";
import { counted } from "@/lib/number";
import { useState } from "react";
import { useCatalog } from "@/lib/catalog-cache";
import { PageSkeleton } from "@/components/ui";
import { PageScroll } from "@/components/PageScroll";
import type { GameRow } from "@/lib/api";
export default function CatalogPage(){
 const [query,setQuery]=useState("");
 const {data:rows,error,loading}=useCatalog<GameRow[]>("/api/games");
 const visible=(rows??[]).filter(row=>row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 return <><div className="page-toolbar"><input className="field toolbar-search" aria-label="Найти игру" placeholder="Название игры или категории" value={query} onChange={e=>setQuery(e.target.value)}/><span className="toolbar-count">{rows?visible.length:"…"}</span></div><PageScroll>{error&&<p role="alert">{error}</p>}{loading&&<PageSkeleton/>}
 <div className="catalog-grid">{visible.map(row=><Link className="card catalog-entry" href={"/games/"+row.slug} key={row.slug}>{row.boxArt&&<img src={row.boxArt} alt=""/>}<div><b>{row.title}</b><p className="sub">{counted(row.clips,"клип","клипа","клипов")} · {counted(row.vods,"эфир","эфира","эфиров")}</p></div></Link>)}</div>
 {rows&&!visible.length&&<div className="card empty">{query?"Ничего не найдено":"Категорий пока нет"}</div>}</PageScroll></>;
}
