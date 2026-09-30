"use client";
import {useState} from 'react';
import {api} from '@/lib/api';
import {toast} from '@/lib/toast';
import {Select} from './Select';
import {Button} from './ui';

export interface VodAdSettings {enabled:boolean;override:boolean|null;streamerEnabled:boolean;source:string}
export function AdSetting({scope,id,value,streamerEnabled,onSaved}:{scope:'streamer'|'vod';id:string;value:boolean|null;streamerEnabled?:boolean;onSaved:()=>void}) {
  const [busy,setBusy]=useState(false);
  const label=scope==='streamer'?'Проверка рекламы всех эфиров':'Проверка рекламы этого эфира';
  const save=async(next:string,applyToAll=false)=>{
    setBusy(true);
    try {
      await api.post(`/api/${scope==='streamer'?'streamers':'vods'}/${encodeURIComponent(id)}/ads`,{
        enabled:next==='inherit'?null:next==='on',...(scope==='streamer'?{applyToAll}:{}),
      });
      onSaved();
    } catch(error) {toast.error(String(error));} finally {setBusy(false);}
  };
  return <div className="audio-setting">
    <div className="audio-setting-control"><b>{label}</b>
      <Select label={label} value={value===null?'inherit':value?'on':'off'} disabled={busy} onValueChange={v=>save(v)} options={[
        ...(scope==='vod'?[{value:'inherit',label:`Как у стримера · ${streamerEnabled?'включена':'выключена'}`}]:[]),
        {value:'on',label:'Включена'},{value:'off',label:'Выключена'},
      ]}/>
      {scope==='streamer'&&<Button busy={busy} onClick={()=>save(value?'on':'off',true)}>Применить ко всем эфирам</Button>}
    </div>
  </div>;
}
