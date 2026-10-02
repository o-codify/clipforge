"use client";
import {useEffect,useState} from 'react';
import {api,when,type PlatformAccount} from '@/lib/api';
import {Button} from './ui';
import {Select} from './Select';
import {SettingsCard} from './SettingsCard';
import {toast} from '@/lib/toast';
import Link from 'next/link';
import {StreamerBadge} from './StreamerBadge';

type Policy={jobId:string;login:string;enabled:boolean;channelId:string;intervalMinutes:number;dailyLimit:number|null;privacy:'public'|'private'|'unlisted';state:string;nextAt?:string;error?:string};
type Row={policy:Policy;ready:number;uploaded:number;jobState:string;target:number;attempts24h:number};
const labels:Record<string,string>={waiting:'Ожидание',paused:'Приостановлено','waiting-channel':'Подключите YouTube',
  'waiting-clips':'Ожидание готового клипа','waiting-upload':'Ожидание загрузки',uploading:'Загрузка',interval:'Ожидание интервала',
  'daily-limit':'Предел ClipForge','youtube-limit':'Ожидание лимита YouTube',completed:'Опубликовано',error:'Нужно внимание'};

export function BatchPublications({login,batchId}:{login?:string;batchId?:string}) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  const [rows,setRows]=useState<Row[]>([]),[accounts,setAccounts]=useState<PlatformAccount[]>([]);
  const [channel,setChannel]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[defaultChannel,setDefaultChannel]=useState('');
  const load=async()=>{try{
    const result=await api.get<Row[]>('/api/platforms/batches');setRows(result);setError('');
  }catch{setError('Не удалось загрузить очередь публикации');}};
  useEffect(()=>{void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},30000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(batchId)void api.get<PlatformAccount[]>('/api/platforms').then(setAccounts).catch(()=>{});},[batchId]);
  const visible=rows.filter(r=>!login||r.policy.login===login);
  const act=async(fn:()=>Promise<unknown>)=>{setBusy(true);try{await fn();await load();}catch(e){toast.error(String(e));}finally{setBusy(false);}};
  useEffect(()=>{if(login)void api.get<{account:PlatformAccount|null}>(`/api/platforms/youtube/destination/${login}`).then(d=>setDefaultChannel(d.account?.externalId??'')).catch(()=>{});},[login]);
  const channelId=channel||defaultChannel;
  return <>
    {error&&<p role="alert">{error}</p>}
    {batchId&&!visible.some(r=>r.policy.jobId===batchId)&&<div className="audio-setting-control" style={{flexWrap:'wrap',gap:12}}>
      <Select label="Канал подборки" value={channelId} onValueChange={setChannel} options={accounts.filter(a=>a.platform==='youtube'&&!a.disconnectRequestedAt).map(a=>({value:a.externalId,label:a.label}))}/>
      <Button disabled={busy||!channelId} onClick={()=>void act(()=>api.post(`/api/platforms/batches/${batchId}`,{enabled:true,channelId,intervalMinutes:10,dailyLimit:null,privacy:'public'}))}>Публиковать по мере готовности</Button>
      <span>По одному каждые 10 минут · до лимита YouTube · публично</span>
    </div>}
    {visible.map(({policy:p,ready,uploaded,target,attempts24h})=><SettingsCard key={p.jobId} title="Публикация подборки" status={labels[p.state]??p.state} tone={p.state==='error'?'bad':p.state==='waiting-channel'?'warn':''}
      actions={<Button disabled={busy} onClick={()=>void act(()=>p.enabled?api.del(`/api/platforms/batches/${p.jobId}`):api.post(`/api/platforms/batches/${p.jobId}`,{enabled:true,channelId:p.channelId,intervalMinutes:p.intervalMinutes,dailyLimit:p.dailyLimit,privacy:p.privacy}))}>{p.enabled?'Приостановить':'Продолжить'}</Button>}>
      {!login&&<StreamerBadge login={p.login}/>}
      <progress value={uploaded} max={target||Math.max(ready,1)} aria-label="Подборка опубликована"/>
      <dl className="settings-facts" style={{gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))'}}><div><dt>Готово / цель</dt><dd>{ready} / {target||'—'}</dd></div><div><dt>Загружено</dt><dd>{uploaded}</dd></div><div><dt>Интервал</dt><dd>{p.intervalMinutes} мин</dd></div><div><dt>Режим</dt><dd>{p.dailyLimit==null?'До лимита YouTube':`До ${p.dailyLimit} за 24 ч`}</dd></div>{p.dailyLimit!=null&&<div><dt>Осталось по своему пределу</dt><dd>{Math.max(0,p.dailyLimit-(attempts24h??0))}</dd></div>}
        {p.enabled&&p.nextAt&&<div><dt>До следующей загрузки</dt><dd>{countdown(Date.parse(p.nextAt)-now)}</dd></div>}
        {p.nextAt&&<div><dt>Следующая загрузка не раньше</dt><dd>{when(p.nextAt)}</dd></div>}</dl>
      {p.state==='waiting-channel'&&<Link href="/settings/publication">Подключить канал YouTube</Link>}
      {p.error&&<p role="alert" className="task-error">{p.error}</p>}
    </SettingsCard>)}
  </>;
}
export function countdown(ms:number){if(ms<=0)return 'Ожидаем свободный слот';const s=Math.ceil(ms/1000);return `${Math.floor(s/3600)?Math.floor(s/3600)+' ч ':''}${Math.floor(s/60)%60} мин ${s%60} с`;}
