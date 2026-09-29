"use client";
import Link from "next/link";
import { counted } from "@/lib/number";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { useCatalog } from "@/lib/catalog-cache";
import { PageSkeleton } from "@/components/ui";
import { PageScroll } from "@/components/PageScroll";
import { StreamerBadge } from "@/components/StreamerBadge";
import type { StreamerRow } from "@/lib/api";
export default function CatalogPage(){
 const {viewer}=useSession();const [query,setQuery]=useState("");
 const {data:rows,error,loading}=useCatalog<StreamerRow[]>("/api/streamers");
 const visible=(rows??[]).filter(row=>(row.login+" "+(row.displayName??"")).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 return <><div className="page-toolbar"><input className="field toolbar-search" aria-label="Найти стримера" placeholder="Имя стримера" value={query} onChange={e=>setQuery(e.target.value)}/><span className="toolbar-count">{rows?visible.length:"…"}</span>{viewer.isAdmin&&<Link className="btn" href="/discovery">Поиск новых каналов</Link>}</div><PageScroll>{error&&<p role="alert">{error}</p>}{loading&&<PageSkeleton/>}
 <div className="catalog-grid">{visible.map(row=><Link className="card catalog-entry" href={"/streamers/"+row.login} key={row.login}><StreamerBadge login={row.login} name={row.displayName} avatar={row.avatar} linked={false}/><p className="sub">{counted(row.clips,"клип","клипа","клипов")} · {counted(row.vods,"эфир","эфира","эфиров")}</p></Link>)}</div>
 {rows&&!visible.length&&<div className="card empty">{query?"Ничего не найдено":"Каналов пока нет"}</div>}</PageScroll></>;
}
