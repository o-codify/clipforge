"use client";
import {useEffect,useState} from 'react';
import {api,when} from '@/lib/api';
import {useSession} from '@/lib/session';
import {BatchPublications} from '@/components/BatchPublications';
import {PublicationFeeds} from '@/components/PublicationFeeds';
import {PageScroll} from '@/components/PageScroll';
import {Button,Pill} from '@/components/ui';
import {LoadError} from '@/components/SettingsCard';
import {StreamerBadge} from '@/components/StreamerBadge';
import Link from 'next/link';
type Process={quota:{state:string;limit:number|null;used:number|null;remaining:number|null;checkedAt:string;resetAt:string;reason?:string}|null;available:number|null;reserved:number|null;resetAt:string;channels:{id:string;label:string;attemptsToday:number;uploadedToday:number;attempts24h:number}[];uploads:{id:string;title:string;streamer:string;streamerName:string;avatar:string|null;channel:string;status:string;error:string|null;progress?:{bytes:number;total:number}}[]};
export default function PublicationsPage(){
  const {viewer}=useSession();const [data,setData]=useState<Process|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const load=()=>api.get<Process>('/api/publication-process').then(x=>{setData(x);setError('');}).catch(()=>setError('Не удалось загрузить публикации'));
  useEffect(()=>{if(!viewer.isAdmin)return;void load();const t=setInterval(()=>{if(document.visibilityState==='visible')void load();},5000);return()=>clearInterval(t);},[viewer.isAdmin]);
  if(!viewer.isAdmin)return <PageScroll><div className="empty">Раздел доступен администратору.</div></PageScroll>;
  return <><div className="page-toolbar"><span>Очередь публикаций</span><Link href="/shorts">Опубликованные Shorts</Link><Link href="/settings/publication">Подключения YouTube</Link><Button busy={busy} onClick={()=>{setBusy(true);void api.post('/api/publication-process/quota').then(load).catch(()=>setError('Не удалось проверить квоту')).finally(()=>setBusy(false));}}>Проверить квоту</Button></div><PageScroll>
    {error&&<LoadError message={error} retry={()=>void load()}/>}
    {data&&<><section className="metric-panel quota-panel"><header><h2>Квота загрузок API-проекта</h2><Pill tone={data.quota?.state==='ok'?'ok':'warn'}>{data.quota?.state==='ok'?'Google Cloud':'Остаток неизвестен'}</Pill></header><dl className="settings-facts"><div><dt>Лимит проекта</dt><dd>{data.quota?.limit??'—'}</dd></div><div><dt>Использовано</dt><dd>{data.quota?.used??'—'}</dd></div><div><dt>Осталось в Google Cloud</dt><dd>{data.quota?.remaining??'—'}</dd></div><div><dt>Доступно с учётом новых запросов</dt><dd>{data.available??'—'}</dd></div><div><dt>Сброс квоты</dt><dd>{when(data.quota?.resetAt??data.resetAt)}</dd></div></dl><p className="muted">{data.quota?.state==='ok'?`Проверено ${when(data.quota.checkedAt)} · расход Google Cloud может поступать с задержкой`:data.quota?.reason??'Подключите чтение квоты Google Cloud. Лимит канала YouTube не раскрывает.'}</p></section>
    <div className="analytics-kpis">{data.channels.map(c=><article className="metric-panel" key={c.id}><h2>{c.label}</h2><dl className="settings-facts"><div><dt>Готово из заявок сегодня</dt><dd>{c.uploadedToday}</dd></div><div><dt>Запросов API учтено</dt><dd>{c.attemptsToday}</dd></div></dl><span className="muted">Учёт ClipForge · день YouTube</span></article>)}</div>
    <PublicationFeeds/><BatchPublications/>
    <section className="metric-panel"><h2>Загрузка и обработка</h2>{!data.uploads.length?<div className="empty">Нет ожидающих публикаций и ошибок</div>:<div className="table-scroll"><table><thead><tr><th>Клип</th><th>Стример</th><th>Канал</th><th>Состояние</th></tr></thead><tbody>{data.uploads.map(p=><tr key={p.id}><td>{p.title}</td><td><StreamerBadge login={p.streamer} name={p.streamerName} avatar={p.avatar}/></td><td>{p.channel}</td><td>{({queued:'В очереди',uploading:'Загружается',processing:'Обрабатывается YouTube',failed:'Сбой'} as Record<string,string>)[p.status]}{p.status==='uploading'&&p.progress&&<><progress max={p.progress.total} value={p.progress.bytes}/><span>{Math.min(100,Math.round(p.progress.bytes/p.progress.total*100))}% · отправлено</span></>}{p.error&&<p className="task-error">{p.error}</p>}</td></tr>)}</tbody></table></div>}</section></>}
  </PageScroll></>;
}
