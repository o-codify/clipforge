"use client";
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {api,when} from '@/lib/api';
import {jobAction} from '@/lib/job-description';
import {PageScroll} from './PageScroll';
import {LoadError} from './SettingsCard';
import {Button,Pill} from './ui';
import {Select} from './Select';
import {StreamerBadge} from './StreamerBadge';
import {toast} from '@/lib/toast';
type Task={id:string;name:string;stage:string|null;startedAt:string;streamer:string|null;vodId:string|null};
type Worker={id:string;label:string;role:string;host:string;state:string;draining:boolean;legacy?:boolean;heartbeatAt:string;queues:string[];active:Task[];resources?:{allocation?:{cpus:number;memoryMb:number;usedMb:number};freeGb?:number;paused?:boolean;reason?:string;metrics?:{ownMemoryMb:number};cpuPercent?:number;downloadKbps?:number;uploadKbps?:number}};
const roles:Record<string,string>={media:'Обработка',control:'Планирование',all:'Все задачи'};
const stateLabels:Record<string,string>={created:'В очереди',retry:'Ожидает повтора',active:'В работе',completed:'Завершено',failed:'Сбой',cancelled:'Отменено'};
export function WorkersWorkspace(){
  const [rows,setRows]=useState<Worker[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(''),[status,setStatus]=useState('all'),[setup,setSetup]=useState(false);
  const load=()=>api.get<Worker[]>('/api/workers').then(x=>{setRows(x);setError('');}).catch(()=>setError('Не удалось загрузить воркеры'));
  useEffect(()=>{void load();const t=setInterval(()=>{if(document.visibilityState==='visible')void load();},5000);return()=>clearInterval(t);},[]);
  const command='docker run -d --name clipforge-worker --restart unless-stopped --init --cpus=4 --cpu-shares=256 --memory=8g --memory-swap=8g --pids-limit=256 --env-file worker.env --mount source=clipforge-worker-1,target=/storage ghcr.io/o-codify/clipforge-worker:fleet-preview';
  return <><div className="page-toolbar"><Select label="Состояние воркера" value={status} onValueChange={setStatus} options={[{value:'all',label:'Все воркеры'},{value:'online',label:'На связи'},{value:'offline',label:'Отключены'}]}/><span className="toolbar-count">На связи: {rows.filter(r=>r.state==='online').length}</span><Button onClick={()=>setSetup(!setup)}>Подключить воркер</Button><Link href="/jobs">Все задания</Link></div><PageScroll>
    {error&&<LoadError message={error} retry={()=>void load()}/>}
    {setup&&<section className="metric-panel"><h2>Docker-воркер</h2><p>Сохраните настройки доступа к базе и хранилищу в worker.env на устройстве. Затем выполните команду:</p><pre className="worker-command">{command}</pre><p className="muted">Для второго контейнера укажите другое имя и том. CPU и память — максимум на контейнер; внутри сохраняется запас 10%. Подробности: docs/docker-workers.md.</p><Button onClick={()=>void navigator.clipboard.writeText(command).then(()=>toast.info('Команда скопирована'))}>Скопировать команду</Button></section>}
    <div className="workers-grid">{rows.filter(w=>status==='all'||w.state===status).map(w=><article className="metric-panel" key={w.id}><header><h2>{w.label}</h2><Pill tone={w.state==='offline'?'':w.draining||w.resources?.paused?'warn':'ok'}>{w.state==='offline'?'Отключён':w.draining?'Завершает работу':w.resources?.paused?'Ожидает ресурсы':'На связи'}</Pill></header><p className="muted">{roles[w.role]??w.role} · {w.host||'Предыдущая версия'}</p><dl className="worker-facts"><div><dt>CPU, доступно</dt><dd>{w.resources?.allocation?.cpus??'—'}</dd></div><div><dt>Память / предел</dt><dd>{w.resources?.allocation?`${(w.resources.allocation.usedMb/1024).toFixed(1)} / ${(w.resources.allocation.memoryMb/1024).toFixed(1)} ГБ`:'—'}</dd></div><div><dt>Свободно на диске</dt><dd>{w.resources?.freeGb?.toFixed(1)??'—'} ГБ</dd></div><div><dt>Связь</dt><dd>{when(w.heartbeatAt)}</dd></div></dl><ul className="worker-jobs">{w.active.map(j=><li key={j.id}><strong>{jobAction(j)}</strong>{j.streamer&&<div><StreamerBadge login={j.streamer}/></div>}<p>{friendlyStage(j.stage)}</p>{j.vodId&&<Link href={`/vods/${j.vodId}`}>Эфир</Link>}</li>)}</ul>{!w.active.length&&<p className="muted">{w.legacy?'Для привязки задач требуется перезапуск обновлённого воркера':w.state==='online'?'Свободен':'Нет текущих задач'}</p>}<div className="dialog-actions"><Link className="btn" href={`/jobs?worker=${encodeURIComponent(w.id)}`}>Задания воркера</Link>{!w.legacy&&<Button busy={busy===w.id} onClick={()=>{setBusy(w.id);void api.post(`/api/workers/${encodeURIComponent(w.id)}/drain`,{draining:!w.draining}).then(load).catch(e=>toast.error(String(e))).finally(()=>setBusy(''));}}>{w.draining?'Принимать задания':'Не брать новые'}</Button>}</div></article>)}</div>
    {!rows.length&&!error&&<div className="empty">Воркеры пока не подключены</div>}
  </PageScroll></>;
}
export function friendlyStage(stage:string|null){
  if(!stage)return 'Подготовка';
  if(/^Результат:/.test(stage))return 'Результат сохранён';
  if(/^Сбой:/.test(stage))return 'Нужна проверка';
  if(/transcrib|распознав|speech/i.test(stage))return 'Распознавание речи';
  if(/render|монтаж|ffmpeg/i.test(stage))return 'Монтаж клипов';
  if(/download|загруз|скачив/i.test(stage))return 'Передача файлов';
  if(/Подборка:/.test(stage))return stage;
  return stage.length<180&&!/[{}]|\\|Traceback/.test(stage)?stage:'Обработка материала';
}
type Run=Task&{state:string;createdAt:string;completedAt:string|null;workerId:string|null;workerName:string|null;streamerName:string;avatar:string|null};
export function WorkerJobs({onGroups}:{onGroups:()=>void}){
  const [workers,setWorkers]=useState<Worker[]>([]),[worker,setWorker]=useState(''),[state,setState]=useState(''),[page,setPage]=useState(1);
  const [data,setData]=useState<{rows:Run[];hasMore:boolean;total:number}|null>(null),[error,setError]=useState(''),[version,setVersion]=useState(0);
  useEffect(()=>{setWorker(new URLSearchParams(window.location.search).get('worker')??'');void api.get<Worker[]>('/api/workers').then(setWorkers).catch(()=>{});},[]);
  useEffect(()=>{let alive=true;const p=new URLSearchParams({page:String(page)});if(worker)p.set('worker',worker);if(state)p.set('state',state);
    void api.get<NonNullable<typeof data>>('/api/workers/jobs?'+p).then(x=>{if(alive){setData(x);setError('');}}).catch(()=>{if(alive)setError('Не удалось загрузить задания');});return()=>{alive=false;};},[page,worker,state,version]);
  useEffect(()=>{const t=setInterval(()=>{if(document.visibilityState==='visible')setVersion(v=>v+1);},5000);return()=>clearInterval(t);},[]);
  return <><div className="page-toolbar"><div className="filter-tabs"><button aria-pressed>Все запуски</button><button onClick={onGroups}>Повторяющиеся задачи</button></div><Select label="Воркер" value={worker} onValueChange={v=>{setWorker(v);setPage(1);}} options={[{value:'',label:'Все воркеры'},...workers.map(w=>({value:w.id,label:w.label}))]}/><Select label="Состояние" value={state} onValueChange={v=>{setState(v);setPage(1);}} options={[{value:'',label:'Все состояния'},{value:'active',label:'В работе'},{value:'waiting',label:'В очереди'},{value:'completed',label:'Завершены'},{value:'failed',label:'Сбои'}]}/><Link href="/workers">Воркеры</Link><span className="toolbar-count">{data?.total??'…'}</span></div><PageScroll>{error&&<LoadError message={error} retry={()=>setVersion(v=>v+1)}/>}<div className="metric-panel table-scroll"><table><thead><tr><th>Задание</th><th>Материал</th><th>Воркер</th><th>Состояние</th><th>Ход работы</th><th>Создано / завершено</th></tr></thead><tbody>{data?.rows.map(j=><tr key={j.id}><td>{jobAction(j)}</td><td>{j.streamer&&<StreamerBadge login={j.streamer} name={j.streamerName} avatar={j.avatar}/>} {j.vodId&&<Link href={`/vods/${j.vodId}`}>Эфир</Link>}</td><td>{j.workerName??(['created','retry'].includes(j.state)?'Ожидает воркер':'—')}</td><td><Pill tone={j.state==='active'?'warn':j.state==='completed'?'ok':j.state==='failed'?'bad':''}>{stateLabels[j.state]??j.state}</Pill></td><td>{j.state==='active'?friendlyStage(j.stage):'—'}</td><td>{when(j.createdAt)}<br/>{when(j.completedAt)}</td></tr>)}</tbody></table>{data?.rows.length===0&&<div className="empty">Заданий не найдено</div>}</div><div className="pagination"><Button disabled={page===1} onClick={()=>setPage(p=>p-1)}>Назад</Button><span>{page}</span><Button disabled={!data?.hasMore} onClick={()=>setPage(p=>p+1)}>Далее</Button></div></PageScroll></>;
}
