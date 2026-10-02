"use client";
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {api,type PlatformAccount} from '@/lib/api';
import {Select} from './Select';
import {Button} from './ui';
import {toast} from '@/lib/toast';

export function StreamerPublicationSetting({login,value,onSaved}:{login:string;value:string|null;onSaved:()=>void}) {
  const [accounts,setAccounts]=useState<PlatformAccount[]>([]),[selected,setSelected]=useState(value??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>setSelected(value??''),[value]);
  useEffect(()=>{void api.get<PlatformAccount[]>('/api/platforms').then(setAccounts).catch(()=>setError('Не удалось загрузить каналы'));},[]);
  const active=accounts.filter(a=>a.platform==='youtube'&&!a.disconnectRequestedAt);
  const options=[{value:'',label:'По умолчанию · Кузня Клипов'},...active.map(a=>({value:a.externalId,label:a.label}))];
  if(value&&!active.some(a=>a.externalId===value))options.push({value,label:'Выбранный канал недоступен'});
  return <div className="audio-setting">
    <div><h3>Канал публикации</h3><p className="muted">Для новых публикаций и подборок этого стримера.</p></div>
    <div className="audio-setting-control"><Select label="Канал публикации стримера" value={selected} onValueChange={setSelected} options={options} disabled={busy}/>
      <Button disabled={busy||selected===(value??'')} busy={busy} onClick={async()=>{setBusy(true);try{await api.post(`/api/streamers/${login}/youtube-channel`,{channelId:selected||null});toast.info('Канал публикации сохранён');onSaved();}catch(e){toast.error(String(e));}finally{setBusy(false);}}}>Сохранить</Button>
      <Link href="/settings/publication">Добавить канал</Link>
    </div>{error&&<p role="alert">{error}</p>}
  </div>;
}
