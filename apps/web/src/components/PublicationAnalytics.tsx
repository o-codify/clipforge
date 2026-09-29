"use client";
import { useCallback, useEffect, useState } from "react";
import { api, when } from "@/lib/api";
import { Button, Pill } from "./ui";
import { LoadError } from "./SettingsCard";
import { StreamerBadge } from "./StreamerBadge";
import { useJobs } from '@/lib/jobs';

export interface VideoAnalyticsRow {
  id:string; videoId:string; title:string|null; url:string|null; privacy:string|null; status:string;
  channel:string; streamer:string; streamerName:string|null; avatar:string|null;
  views:number|null; likes:number|null; comments:number|null; collectedAt:string|null;
  details:{restrictionsChecked?:boolean;regionRestriction?:{allowed?:string[];blocked?:string[]}|null;ageRestricted?:boolean|null}|null;
}
interface Analytics {
  rows:VideoAnalyticsRow[]; page:number; hasMore:boolean; collectorOnline:boolean;
  sync:{state:string;updatedAt:string|null};
}
const number = (value:number|null) => value===null ? "—" : value.toLocaleString("ru-RU");
const visibility:Record<string,string>={public:"Публично",private:"Приватно",unlisted:"По ссылке"};
const countryNames = new Intl.DisplayNames(["ru"], {type:"region"});
function countries(codes:string[]) { return codes.map(code=>/^[A-Z]{2}$/.test(code) ? countryNames.of(code)??code : code).join(", "); }
export function publicationRestrictions(details:VideoAnalyticsRow['details']) {
  if(!details?.restrictionsChecked)return "Ещё не проверены";
  const result:string[]=[];
  if(details.ageRestricted)result.push("18+");
  const region=details.regionRestriction;
  if(region?.allowed)result.push(region.allowed.length ? `Доступно только: ${countries(region.allowed)}` : "Недоступно во всех странах");
  if(region?.blocked?.length)result.push(`Недоступно: ${countries(region.blocked)}`);
  return result.join(" · ")||"Возрастные и региональные не указаны";
}
export function PublicationAnalyticsTable({rows}:{rows:VideoAnalyticsRow[]}) {
  return <div className="publication-analytics-table" tabIndex={0} role="region" aria-label="Статистика видео YouTube"><table>
    <thead><tr><th>Видео</th><th>Видимость</th><th>Просмотры</th><th>Лайки</th><th>Комментарии</th><th>Ограничения</th><th>Обновлено</th></tr></thead>
    <tbody>{rows.map(row=><tr key={row.id}>
      <th scope="row"><a className="publication-video-title" href={`https://www.youtube.com/watch?v=${encodeURIComponent(row.videoId)}`} target="_blank" rel="noopener noreferrer">{row.title||"Видео YouTube"}</a>
        <div className="publication-video-author"><StreamerBadge login={row.streamer} name={row.streamerName} avatar={row.avatar}/><span>{row.channel}</span></div></th>
      <td><Pill tone={row.status==='published'&&row.privacy==='public'?"ok":row.status==='failed'?"bad":""}>{row.status==='failed'?"Ошибка":row.status==='processing'?"Обрабатывается":visibility[row.privacy??'']??"Не определена"}</Pill></td>
      <td className="metric-value">{number(row.views)}</td><td className="metric-value">{number(row.likes)}</td><td className="metric-value">{number(row.comments)}</td>
      <td className="publication-restrictions">{publicationRestrictions(row.details)}</td>
      <td><time dateTime={row.collectedAt??undefined}>{row.collectedAt?when(row.collectedAt):"Ожидаем данные"}</time>{row.collectedAt&&Date.now()-Date.parse(row.collectedAt)>75*60000&&<span className="publication-stale">Данные устарели</span>}</td>
    </tr>)}</tbody>
  </table></div>;
}
export function PublicationAnalytics() {
  const [data,setData]=useState<Analytics|null>(null),[page,setPage]=useState(1),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [syncing,setSyncing]=useState(false),[notice,setNotice]=useState(''),[syncJob,setSyncJob]=useState<string|null>(null);
  const {jobs,refresh,version}=useJobs();
  const running=jobs.some(job=>job.name==='light.refresh-youtube'&&['created','active','retry'].includes(job.state));
  const load=useCallback(async()=>{
    setBusy(true);setError('');
    try {setData(await api.get<Analytics>(`/api/operations/analytics/videos?page=${page}`));}
    catch {setError('Не удалось загрузить статистику YouTube');}
    finally {setBusy(false);}
  },[page]);
  useEffect(()=>{void load()},[load,version]);
  useEffect(()=>{
    const job=jobs.find(item=>item.id===syncJob);
    if(!job||['created','active','retry'].includes(job.state))return;
    setSyncJob(null);
    setNotice(job.state==='completed'?'Данные YouTube обновлены':job.state==='cancelled'?'Обновление отменено':'Не удалось обновить данные YouTube');
  },[jobs,syncJob]);
  async function sync() {
    setSyncing(true);setError('');setNotice('');
    try {
      const result=await api.post<{jobId:string|null}>('/api/platforms/youtube/refresh',{});
      setSyncJob(result.jobId);setNotice('Обновление в очереди');refresh();
    } catch {setError('Не удалось запустить обновление YouTube');}
    finally {setSyncing(false);}
  }
  return <section className="publication-analytics">
    <div className="settings-section-heading"><div><span className="eyebrow">YouTube</span><h2>Статистика видео</h2></div><Button busy={syncing||running} disabled={busy} onClick={()=>void sync()}>Обновить из YouTube</Button></div>
    {notice&&<p role="status">{notice}</p>}
    {error&&<LoadError message={error} retry={()=>void load()}/>}
    {!data&&!error&&<div className="settings-empty" role="status">Загрузка статистики…</div>}
    {data&&<><div className="publication-analytics-status"><Pill tone={!data.collectorOnline||data.sync.state==='error'?"warn":"ok"}>{!data.collectorOnline?"Обновление приостановлено":data.sync.state==='error'?"Не удалось обновить статистику":"Обновление каждый час"}</Pill><span>Просмотры, лайки и комментарии по данным YouTube</span></div>
      {data.rows.length?<PublicationAnalyticsTable rows={data.rows}/>:<div className="settings-empty">Пока нет загруженных видео</div>}
      {(data.page>1||data.hasMore)&&<div className="publication-analytics-pages"><Button disabled={busy||data.page===1} onClick={()=>setPage(data.page-1)}>Назад</Button><span>Страница {data.page}</span><Button disabled={busy||!data.hasMore} onClick={()=>setPage(data.page+1)}>Далее</Button></div>}
    </>}
  </section>;
}
