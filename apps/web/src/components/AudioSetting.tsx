"use client";
import {useState} from 'react';
import {api} from '@/lib/api';
import {toast} from '@/lib/toast';
import {Select} from './Select';

export type AudioMode='original'|'dtln'|'dtln-gated';
export interface VodAudioSettings {mode:AudioMode;override:AudioMode|null;streamerMode:AudioMode;source:string}

export function AudioSetting({scope,id,value,streamerMode,onSaved}:{scope:'streamer'|'vod';id:string;value:AudioMode|null;streamerMode?:AudioMode;onSaved:()=>void}) {
  const [busy,setBusy]=useState(false);
  const label=scope==='streamer'?'Звук клипов всех эфиров':'Звук клипов этого эфира';
  const save=async(next:string)=>{
    setBusy(true);
    try {
      await api.post(`/api/${scope==='streamer'?'streamers':'vods'}/${encodeURIComponent(id)}/audio`,{audioMode:next==='inherit'?null:next});
      onSaved();
    } catch(error) {toast.error(String(error));}
    finally {setBusy(false);}
  };
  return <div className="audio-setting">
    <div className="audio-setting-control">
      <b>{label}</b>
      <Select label={label} value={value??'inherit'} disabled={busy} onValueChange={save} options={[
        ...(scope==='vod'?[{value:'inherit',label:`Как у стримера · ${streamerMode==='original'?'исходный звук':streamerMode==='dtln-gated'?'DTLN + паузы':'DTLN'}`}]:[]),
        {value:'original',label:'Исходный звук'},
        {value:'dtln',label:'DTLN'},
        {value:'dtln-gated',label:'DTLN + паузы речи'},
      ]}/>
    </div>
    <p className="muted">{scope==='streamer'?'Для новых клипов текущих и будущих эфиров. Отдельный эфир может иметь свою настройку.':'Для новых клипов этого эфира. Уже созданные клипы не изменяются.'}</p>
    {(value&&value!=='original'||value===null&&streamerMode!=='original')&&<p className="muted">DTLN может ослаблять звуки игры и сохранять вокал песни.</p>}
  </div>;
}
