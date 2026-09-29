"use client";
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from './ui';
export type MediaSafety = {method?:string;regions:number;qrHits:number;bannerHits:number;reviewedAt:string|null;autoVerifiedAt?:string|null;profileFrames?:number};

export function ClipCleanup({id,state,safety,onReady,onReview}:{id:string;state:string;safety?:MediaSafety|null;onReady:(id:string)=>void;onReview:()=>void}) {
  const [job,setJob]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(!job)return;
    let active=true,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      try{
        const latest=await api.get<{state:string;output?:{clipId?:string;message?:string}}>(`/api/jobs/${job}/status`);
        if(!active)return;
        if(latest.state==='completed'&&latest.output?.clipId){setJob(null);onReady(latest.output.clipId);return;}
        if(['failed','cancelled'].includes(latest.state)){setError(latest.output?.message||'Не удалось завершить обработку');setJob(null);return;}
      }catch{if(active)setError('Не удалось обновить состояние обработки');}
      if(active)timer=setTimeout(refresh,5000);
    };
    timer=setTimeout(refresh,2000);
    return()=>{active=false;clearTimeout(timer);};
  },[job,onReady]);
  const clean=async()=>{
    setBusy(true);setError('');
    try{
      const result=await api.post<{id:string|null}>(`/api/jobs/clean-clip/${id}`,{});
      if(result.id)setJob(result.id);else setError('Обработка уже стоит в очереди');
    }catch(e){setError(String(e));}finally{setBusy(false);}
  };
  return <section className="media-cleanup">
    <h3>QR-коды и реклама</h3>
    {safety?.autoVerifiedAt ? <>
      <p>Обработано автоматически по карте эфира · {safety.profileFrames} кадров · закрыто областей: {safety.regions}</p>
      {state==='draft'&&<Button busy={busy} onClick={async()=>{setBusy(true);try{await api.post(`/api/clips/${id}/state`,{state:'ready'});onReview();}catch(e){setError(String(e));}finally{setBusy(false);}}}>Использовать тестовый клип</Button>}
    </> : <>
      <p>Эта версия создана до автоматической проверки эфира.</p>
      {job?<p role="status">Проверка эфира и обработка клипа выполняются в очереди.</p>:<Button busy={busy} onClick={clean}>Обновить обработку</Button>}
    </>}
    {error&&<p role="alert" className="error">{error}</p>}
  </section>;
}
