"use client";
import {useEffect,useState} from 'react';
import {api} from '@/lib/api';
import {StreamerBadge} from './StreamerBadge';
import {Button,Pill} from './ui';
import {LoadError} from './SettingsCard';
type Policy={id:string;login:string;game:string;startVodId:string;channelId:string;enabled:boolean;intervalMinutes:number;audioMode:string;state:string;error?:string|null};
type Row={policy:Policy;name:string;avatar:string|null;game:string;channel:string;ready:number;uploaded:number};
const labels:Record<string,string>={waiting:'Ожидание',preparing:'Подготовка клипов','buffer-ready':'Клипы готовы','waiting-streams':'Ожидание новых эфиров','waiting-channel':'Канал отключён','youtube-limit':'Ожидание лимита YouTube',paused:'Приостановлено',error:'Нужно внимание'};
export function PublicationFeeds(){
  const [rows,setRows]=useState<Row[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState('');
  const load=()=>api.get<Row[]>('/api/platforms/feeds').then(r=>{setRows(r);setError('');}).catch(()=>setError('Не удалось загрузить постоянные очереди'));
  useEffect(()=>{void load();const t=setInterval(()=>{if(document.visibilityState==='visible')void load();},15000);return()=>clearInterval(t);},[]);
  if(error)return <LoadError message={error} retry={()=>void load()}/>;
  if(!rows.length)return null;
  return <section className="metric-panel"><h2>Постоянные очереди</h2><div className="table-scroll"><table><thead><tr><th>Стример</th><th>Игра</th><th>YouTube</th><th>Клипы</th><th>Публикация</th><th>Состояние</th><th/></tr></thead><tbody>{rows.map(r=><tr key={r.policy.id}>
    <td><StreamerBadge login={r.policy.login} name={r.name} avatar={r.avatar}/></td><td>{r.game}</td><td>{r.channel}</td><td>{r.uploaded} опубликовано · {Math.max(0,r.ready-r.uploaded)} в запасе</td><td>Каждые {r.policy.intervalMinutes} мин</td>
    <td><Pill tone={r.policy.state==='error'?'warn':''}>{labels[r.policy.state]??'Ожидание'}</Pill>{r.policy.error&&<p className="task-error">{r.policy.error}</p>}</td>
    <td><Button busy={busy===r.policy.id} onClick={()=>{const p=r.policy;setBusy(p.id);void api.post('/api/platforms/feeds',{login:p.login,game:p.game,startVodId:p.startVodId,channelId:p.channelId,enabled:p.state==='error'||!p.enabled,intervalMinutes:p.intervalMinutes,audioMode:p.audioMode}).then(load).catch(()=>setError('Не удалось изменить очередь')).finally(()=>setBusy(''));}}>{r.policy.state==='error'?'Повторить':r.policy.enabled?'Приостановить':'Продолжить'}</Button></td>
  </tr>)}</tbody></table></div></section>;
}
