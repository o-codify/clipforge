"use client";
import {useEffect,useMemo,useRef,useState} from 'react';
import Link from 'next/link';
import {api,when,hhmm} from '@/lib/api';
import {useSession} from '@/lib/session';
import {PageScroll} from './PageScroll';
import {Select} from './Select';
import {Button,Pill} from './ui';
import {LoadError} from './SettingsCard';
import {StreamerBadge} from './StreamerBadge';
import {toast} from '@/lib/toast';

type Options={value:string;label:string}[];
type Short={id:string;clipId:string;videoId:string;title:string;streamer:string;streamerName:string;avatar:string|null;gameTitle:string|null;vodId:string;vodTitle:string;vodDate:string;duration:number;channel:string;privacy:string;publishedAt:string|null;uploadedAt:string;views:number|null;likes:number|null;comments:number|null;collectedAt:string|null;details:Record<string,unknown>};
type Point={id:string;title:string;videoId:string;streamer:string;at:string;views:number|null;likes:number|null;comments:number|null};
type Dashboard={summary:{videos:number;measured:number;views:string|null;likes:string|null;comments:string|null;stale:number;lastCheck:string|null};series:Point[];aggregate:Point[];breakdown:{streamer:string;name:string;avatar:string|null;gameTitle:string;videos:number;views:string|null;likes:string|null;comments:string|null}[];feedbackAllowed:boolean;feedback?:{value:{mode:string;samples:number;streamer:string;groups?:number};updatedAt:string};days:number};
const count=(n:number|string|null|undefined)=>n==null?'—':Number(n).toLocaleString('ru-RU');
const colors=['#a970ff','#ff315c','#5bd6c6','#f9c45d','#64aaff','#e585e0','#b4dc67','#ef9370'];

export function ShortsWorkspace({analytics=false}:{analytics?:boolean}){
  const {viewer}=useSession();
  const [filters,setFilters]=useState<{streamers:Options;games:Options;channels:Options}>({streamers:[],games:[],channels:[]});
  const [streamer,setStreamer]=useState(''),[game,setGame]=useState(''),[channel,setChannel]=useState(''),[privacy,setPrivacy]=useState('');
  const [search,setSearch]=useState(''),[debounced,setDebounced]=useState(''),[sort,setSort]=useState('newest'),[days,setDays]=useState('7'),[page,setPage]=useState(1);
  const [chartMode,setChartMode]=useState('all');
  const [rows,setRows]=useState<{rows:Short[];total:number;hasMore:boolean}|null>(null),[dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [error,setError]=useState(''),[loading,setLoading]=useState(true),[version,setVersion]=useState(0),[refreshing,setRefreshing]=useState(false);
  useEffect(()=>{const timer=setTimeout(()=>setDebounced(search),300);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{if(viewer.isAdmin)void api.get<typeof filters>('/api/shorts/filters').then(setFilters).catch(()=>{});},[viewer.isAdmin]);
  const params=useMemo(()=>{const p=new URLSearchParams({page:String(page),sort,days});for(const [key,value] of Object.entries({streamer,game,channel,privacy,search:debounced}))if(value)p.set(key,value);return p.toString();},[streamer,game,channel,privacy,debounced,page,sort,days]);
  useEffect(()=>{if(!viewer.isAdmin)return;let alive=true;setLoading(true);setError('');
    const request=analytics?api.get<Dashboard>('/api/shorts/analytics?'+params).then(x=>{if(alive)setDashboard(x);}):api.get<NonNullable<typeof rows>>('/api/shorts?'+params).then(x=>{if(alive)setRows(x);});
    void request.catch(()=>{if(alive)setError('Не удалось загрузить Shorts');}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};
  },[params,analytics,version,viewer.isAdmin]);
  useEffect(()=>{const t=setInterval(()=>{if(document.visibilityState==='visible')setVersion(v=>v+1);},60000);return()=>clearInterval(t);},[]);
  const filter=(setter:(s:string)=>void)=>(s:string)=>{setter(s);setPage(1);};
  if(!viewer.isAdmin)return <PageScroll><div className="empty">Раздел доступен администратору.</div></PageScroll>;
  return <><div className="page-toolbar shorts-toolbar">
    <Select label="Стример" value={streamer} onValueChange={filter(setStreamer)} options={[{value:'',label:'Все стримеры'},...filters.streamers]}/>
    <Select label="Игра" value={game} onValueChange={filter(setGame)} options={[{value:'',label:'Все игры'},...filters.games]}/>
    <Select label="YouTube-канал" value={channel} onValueChange={filter(setChannel)} options={[{value:'',label:'Все каналы'},...filters.channels]}/>
    <Select label="Видимость" value={privacy} onValueChange={filter(setPrivacy)} options={[{value:'',label:'Любая видимость'},{value:'public',label:'Публичные'},{value:'private',label:'Приватные'},{value:'unlisted',label:'По ссылке'}]}/>
    {analytics?<Select label="Период графиков" value={days} onValueChange={setDays} options={[{value:'1',label:'24 часа'},{value:'7',label:'7 дней'},{value:'21',label:'21 день'}]}/>:<Select label="Порядок" value={sort} onValueChange={filter(setSort)} options={[{value:'newest',label:'Сначала новые'},{value:'oldest',label:'Сначала старые'},{value:'views',label:'По просмотрам'},{value:'likes',label:'По лайкам'}]}/>}
    <input className="field toolbar-search" aria-label="Поиск Shorts" placeholder="Название или эфир" value={search} onChange={e=>filter(setSearch)(e.target.value)}/>
    <Button disabled={refreshing} onClick={()=>{setRefreshing(true);void api.post('/api/platforms/youtube/refresh').then(()=>{toast.info('Обновление поставлено в очередь');setVersion(v=>v+1);}).catch(()=>setError('Не удалось запустить обновление')).finally(()=>setRefreshing(false));}}>Обновить данные</Button>
  </div><PageScroll>
    {error&&<LoadError message={error} retry={()=>setVersion(v=>v+1)}/>}
    {loading&&<p role="status">Загрузка…</p>}
    {analytics&&dashboard&&<>
      <div className="analytics-kpis">{[['Shorts',dashboard.summary.videos],['Просмотры',dashboard.summary.views],['Нравится',dashboard.summary.likes],['Комментарии',dashboard.summary.comments]].map(([label,value])=><article key={label} className="metric-panel"><span>{label}</span><strong>{count(value)}</strong></article>)}</div>
      <div className="analytics-meta"><span>Последние значения YouTube · проверено {dashboard.summary.measured} из {dashboard.summary.videos} · {when(dashboard.summary.lastCheck)}</span>{dashboard.summary.stale>0&&<Pill tone="warn">Ожидают обновления: {dashboard.summary.stale}</Pill>}</div>
      <div className="analytics-meta"><Select label="Графики" value={chartMode} onValueChange={setChartMode} options={[{value:'all',label:'Вся выборка'},{value:'shorts',label:'Сравнить 8 Shorts'}]}/><span>{chartMode==='all'?'Сумма последних известных значений каждого Shorts на момент измерения':'До 8 Shorts с наибольшим числом просмотров в выбранной группе'}</span></div>
      <div className="analytics-charts"><HistoryChart points={chartMode==='all'?dashboard.aggregate:dashboard.series} metric="views" title="Просмотры" days={dashboard.days}/><HistoryChart points={chartMode==='all'?dashboard.aggregate:dashboard.series} metric="likes" title="Нравится" days={dashboard.days}/><HistoryChart points={chartMode==='all'?dashboard.aggregate:dashboard.series} metric="comments" title="Комментарии" days={dashboard.days}/></div>
      <div className="analytics-lower"><section className="metric-panel"><h2>Стримеры и игры</h2><div className="table-scroll"><table><thead><tr><th>Стример</th><th>Игра</th><th>Shorts</th><th>Просмотры</th><th>Нравится</th><th>Комментарии</th></tr></thead><tbody>{dashboard.breakdown.map(r=><tr key={r.streamer+':'+r.gameTitle}><td><StreamerBadge login={r.streamer} name={r.name} avatar={r.avatar}/></td><td>{r.gameTitle||'Без категории'}</td><td>{r.videos}</td><td>{count(r.views)}</td><td>{count(r.likes)}</td><td>{count(r.comments)}</td></tr>)}</tbody></table></div></section>
      <section className="metric-panel"><h2>Автоматический отбор</h2><Pill tone={dashboard.feedbackAllowed?'ok':'warn'}>{dashboard.feedbackAllowed?'Обратная связь включена':'Отбор по сигналам эфира'}</Pill><p>{dashboard.feedbackAllowed?'Результаты зрелых публичных Shorts корректируют отбор следующих моментов.':'Для корректировки отбора по статистике требуется одобрение YouTube сценария Analytics & Reporting.'}</p>{dashboard.feedback&&<><StreamerBadge login={dashboard.feedback.value.streamer}/><dl className="settings-facts"><div><dt>Клипов в выборке</dt><dd>{dashboard.feedback.value.samples}</dd></div><div><dt>Последний отбор</dt><dd>{when(dashboard.feedback.updatedAt)}</dd></div></dl></>}</section></div>
    </>}
    {!analytics&&rows&&<><div className="analytics-meta"><span>{rows.total} Shorts</span><Link href="/analytics">Статистика</Link></div><div className="published-grid">{rows.rows.map(r=><article className="published-card" key={r.id}><a href={`https://www.youtube.com/shorts/${r.videoId}`} target="_blank" rel="noreferrer" className="published-poster" aria-label={`Смотреть ${r.title}`}><img src={`/media/poster/${encodeURIComponent(r.clipId)}`} alt="" loading="lazy"/><span>{hhmm(r.duration)}</span></a><div className="published-info"><StreamerBadge login={r.streamer} name={r.streamerName} avatar={r.avatar}/><h2>{r.title}</h2><p>{r.gameTitle||'Без категории'}</p><Link href={`/vods/${r.vodId}`} className="published-vod" title={r.vodTitle}>Эфир · {when(r.vodDate)}</Link><p className="muted">{r.channel} · {when(r.publishedAt||r.uploadedAt)}</p><Pill tone={r.privacy==='public'?'ok':''}>{r.privacy==='public'?'Публично':r.privacy==='private'?'Приватно':'По ссылке'}</Pill><dl className="short-counts"><div><dt>Просмотры</dt><dd>{count(r.views)}</dd></div><div><dt>Нравится</dt><dd>{count(r.likes)}</dd></div><div><dt>Комментарии</dt><dd>{count(r.comments)}</dd></div></dl><span className="muted">{when(r.collectedAt)}</span></div></article>)}</div>{!rows.rows.length&&<div className="empty">Shorts не найдены</div>}<div className="pagination"><Button disabled={page===1||loading} onClick={()=>setPage(p=>p-1)}>Назад</Button><span>Страница {page}</span><Button disabled={!rows.hasMore||loading} onClick={()=>setPage(p=>p+1)}>Далее</Button></div></>}
  </PageScroll></>;
}

function HistoryChart({points,metric,title,days}:{points:Point[];metric:'views'|'likes'|'comments';title:string;days:number}){
  const [hidden,setHidden]=useState<string[]>([]),[cursor,setCursor]=useState<number|null>(null);
  const svgRef=useRef<SVGSVGElement>(null),[width,setWidth]=useState(780);
  useEffect(()=>{if(!svgRef.current)return;const observer=new ResizeObserver(([entry])=>{if(entry)setWidth(Math.max(260,entry.contentRect.width));});observer.observe(svgRef.current);return()=>observer.disconnect();},[points.length>0]);
  const end=Date.now(),start=end-days*86400000;
  points=points.filter(p=>Date.parse(p.at)>=start&&Date.parse(p.at)<=end);
  const series=[...new Set(points.map(p=>p.id))].map((id,i)=>({id,color:colors[i%colors.length]!,points:points.filter(p=>p.id===id),label:points.find(p=>p.id===id)!.title}));
  const max=Math.max(1,...points.filter(p=>!hidden.includes(p.id)).map(p=>p[metric]??0));
  const x=(at:string)=>64+(Date.parse(at)-start)/(end-start)*(width-84),y=(n:number)=>195-n/max*165;
  const hoveredAt=cursor==null?null:start+(cursor-64)/(width-84)*(end-start);
  const hover=hoveredAt==null?[]:series.filter(s=>!hidden.includes(s.id)).map(s=>({...s,point:s.points.reduce((closest,p)=>Math.abs(Date.parse(p.at)-hoveredAt)<Math.abs(Date.parse(closest.at)-hoveredAt)?p:closest)}));
  return <section className="history-chart metric-panel"><header><h2>{title}</h2><span className="muted">YouTube</span></header>{!points.length?<div className="empty">История появится после сбора статистики</div>:<><svg ref={svgRef} viewBox={`0 0 ${width} 230`} role="img" aria-label={`${title}: история за ${days} дней`} onMouseLeave={()=>setCursor(null)} onMouseMove={e=>{const px=e.clientX-e.currentTarget.getBoundingClientRect().left;setCursor(px>=64&&px<=width-20?px:null);}}>
    {[0,.25,.5,.75,1].map(t=><g key={t}><line x1="64" x2={width-20} y1={y(max*t)} y2={y(max*t)} stroke="var(--border,#44394e)"/><text x="56" y={y(max*t)+4} textAnchor="end">{Intl.NumberFormat('ru',{notation:'compact'}).format(max*t)}</text></g>)}
    {series.filter(s=>!hidden.includes(s.id)).map(s=><g key={s.id}>{s.points.map((p,i)=>{const previous=s.points[i-1];return p[metric]==null?null:<g key={p.at}>{previous&&previous[metric]!=null&&Date.parse(p.at)-Date.parse(previous.at)<3*3600000&&<line x1={x(previous.at)} y1={y(previous[metric]!)} x2={x(p.at)} y2={y(p[metric]!)} stroke={s.color} strokeWidth="2"/>}<circle cx={x(p.at)} cy={y(p[metric]!)} r="3" fill={s.color}><title>{s.label} · {when(p.at)} · {count(p[metric])}</title></circle></g>;})}</g>)}
    {[0,.5,1].map(t=><text key={t} x={64+t*(width-84)} y="220" textAnchor={t===0?'start':t===1?'end':'middle'}>{new Date(start+t*(end-start)).toLocaleString('ru-RU',days===1?{hour:'2-digit',minute:'2-digit'}:{day:'2-digit',month:'2-digit'})}</text>)}
    {cursor!==null&&<line x1={cursor} x2={cursor} y1="25" y2="195" stroke="#fff" strokeDasharray="3 4"/>}
  </svg>{hover.length>0&&<div className="chart-tooltip">{hover.map(s=><div key={s.id}><i style={{background:s.color}}/><span>{s.label}<small>{when(s.point.at)}</small></span><b>{count(s.point[metric])}</b></div>)}</div>}<div className="chart-legend">{series.map(s=><button key={s.id} title={s.label} aria-pressed={!hidden.includes(s.id)} onClick={()=>setHidden(old=>old.includes(s.id)?old.filter(id=>id!==s.id):[...old,s.id])}><i style={{background:s.color}}/>{s.label}</button>)}</div></>}</section>;
}
