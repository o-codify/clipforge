"use client";
import {useEffect,useState} from 'react';
import {api,when,type PlatformAccount} from '@/lib/api';
import {Button} from './ui';
import {Select} from './Select';
import {SettingsCard} from './SettingsCard';
import {toast} from '@/lib/toast';
import Link from 'next/link';
import {StreamerBadge} from './StreamerBadge';

type Policy={jobId:string;login:string;enabled:boolean;channelId:string;intervalMinutes:number;dailyLimit:number;privacy:'public'|'private'|'unlisted';state:string;nextAt?:string;error?:string};
type Row={policy:Policy;ready:number;uploaded:number;jobState:string};
const labels:Record<string,string>={waiting:'Ожидание',paused:'Приостановлено','waiting-channel':'Подключите YouTube',
  'waiting-clips':'Ожидание готового клипа','waiting-upload':'Ожидание загрузки',uploading:'Загрузка',interval:'Ожидание интервала',
  'daily-limit':'Дневной лимит',completed:'Опубликовано',error:'Нужно внимание'};

export function BatchPublications({login,batchId}:{login?:string;batchId?:string}) {
  const [rows,setRows]=useState<Row[]>([]),[accounts,setAccounts]=useState<PlatformAccount[]>([]);
  const [channel,setChannel]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const load=async()=>{try{
    const result=await api.get<Row[]>('/api/platforms/batches');setRows(result);setError('');
  }catch{setError('Не удалось загрузить очередь публикации');}};
  useEffect(()=>{void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},30000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(batchId)void api.get<PlatformAccount[]>('/api/platforms').then(setAccounts).catch(()=>{});},[batchId]);
  const visible=rows.filter(r=>!login||r.policy.login===login);
  const act=async(fn:()=>Promise<unknown>)=>{setBusy(true);try{await fn();await load();}catch(e){toast.error(String(e));}finally{setBusy(false);}};
  const channelId=channel||accounts.find(a=>a.platform==='youtube'&&!a.disconnectRequestedAt)?.externalId||'';
  return <>
    {error&&<p role="alert">{error}</p>}
    {batchId&&!visible.some(r=>r.policy.jobId===batchId)&&<div className="audio-setting-control" style={{flexWrap:'wrap',gap:12}}>
      <Select label="Канал подборки" value={channelId} onValueChange={setChannel} options={accounts.filter(a=>a.platform==='youtube'&&!a.disconnectRequestedAt).map(a=>({value:a.externalId,label:a.label}))}/>
      <Button disabled={busy||!channelId} onClick={()=>void act(()=>api.post(`/api/platforms/batches/${batchId}`,{enabled:true,channelId,intervalMinutes:10,dailyLimit:100,privacy:'public'}))}>Публиковать по мере готовности</Button>
      <span>По одному каждые 10 минут · до 100 за сутки · публично</span>
    </div>}
    {visible.map(({policy:p,ready,uploaded})=><SettingsCard key={p.jobId} title="Публикация подборки" status={labels[p.state]??p.state} tone={p.state==='error'?'bad':p.state==='waiting-channel'?'warn':''}
      actions={<Button disabled={busy} onClick={()=>void act(()=>p.enabled?api.del(`/api/platforms/batches/${p.jobId}`):api.post(`/api/platforms/batches/${p.jobId}`,{enabled:true,channelId:p.channelId,intervalMinutes:p.intervalMinutes,dailyLimit:p.dailyLimit,privacy:p.privacy}))}>{p.enabled?'Приостановить':'Продолжить'}</Button>}>
      {!login&&<StreamerBadge login={p.login}/>}
      <dl className="settings-facts" style={{gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))'}}><div><dt>Готово</dt><dd>{ready}</dd></div><div><dt>Загружено</dt><dd>{uploaded}</dd></div><div><dt>Интервал</dt><dd>{p.intervalMinutes} мин</dd></div><div><dt>Лимит за сутки</dt><dd>{p.dailyLimit}</dd></div>
        {p.nextAt&&<div><dt>Следующая загрузка не раньше</dt><dd>{when(p.nextAt)}</dd></div>}</dl>
      {p.state==='waiting-channel'&&<Link href="/settings/publication">Подключить канал YouTube</Link>}
      {p.error&&<p role="alert" className="task-error">{p.error}</p>}
    </SettingsCard>)}
  </>;
}
