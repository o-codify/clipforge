"use client";
import Link from "next/link";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useCatalog } from "@/lib/catalog-cache";
import type { StreamerRow } from "@/lib/api";

const Directory = createContext(new Map<string, StreamerRow>());
export function StreamerDirectory({children}:{children:ReactNode}) {
  const {data} = useCatalog<StreamerRow[]>("/api/streamers");
  const directory = useMemo(()=>new Map((data??[]).map(row=>[row.login,row])),[data]);
  return <Directory.Provider value={directory}>{children}</Directory.Provider>;
}

/** One cached directory for the workspace, never a request per badge. */
export function StreamerBadge({login,name,avatar,linked=true,external=false}:{login:string;name?:string|null;avatar?:string|null;linked?:boolean;external?:boolean}) {
  const row = useContext(Directory).get(login);
  const [failed,setFailed] = useState<string|null>(null);
  const label = name??row?.displayName??login;
  const image = avatar??row?.avatar;
  const content = <><span className="streamer-badge-avatar">{image&&failed!==image?<img src={image} alt="" loading="lazy" onError={()=>setFailed(image)}/>:<span aria-hidden>{label.slice(0,1).toUpperCase()}</span>}</span><span className="streamer-badge-name">{label}</span></>;
  if (!linked) return <span className="streamer-badge">{content}</span>;
  return external ? <a className="streamer-badge" href={`https://twitch.tv/${login}`} target="_blank" rel="noopener noreferrer">{content}</a> : <Link className="streamer-badge" href={`/streamers/${login}`}>{content}</Link>;
}
