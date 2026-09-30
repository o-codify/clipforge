"use client";
import {useState} from 'react';
import {api} from '@/lib/api';
import {toast} from '@/lib/toast';
import {useJobs} from '@/lib/jobs';
import {JobButton} from './ui';
import {Select} from './Select';
import type {AudioMode} from './AudioSetting';

export function DraftBatch({login}:{login:string}) {
  const [count,setCount]=useState('100');
  const [audio,setAudio]=useState<AudioMode|'inherit'>('inherit');
  const {activeFor}=useJobs();
  const job=activeFor(login,['prepare-streamer']);
  const shownAudio=job?(job.data.audioMode as AudioMode|undefined)??'inherit':audio;
  const valid=Number.isInteger(Number(count))&&Number(count)>=1&&Number(count)<=100;
  return <div className="audio-setting">
    <div className="audio-setting-control" style={{flexWrap:'wrap',gap:12}}>
      <b>Подборка из разных эфиров</b>
      <label>Клипов <input className="field" aria-label="Количество черновиков" type="number" min={1} max={100} disabled={!!job} value={job?String(job.data.count):count} onChange={e=>setCount(e.target.value)} style={{width:85}}/></label>
      <Select label="Звук подборки" value={shownAudio} disabled={!!job} onValueChange={v=>setAudio(v as typeof audio)} options={[
        {value:'inherit',label:'По настройкам эфиров'},{value:'original',label:'Исходный звук'},
        {value:'dtln',label:'DTLN'},{value:'dtln-gated',label:'DTLN + паузы речи'},
      ]}/>
      <JobButton target={login} kinds={['prepare-streamer']} disabled={!valid} onRun={async()=>{
        await api.post(`/api/jobs/prepare-streamer/${encodeURIComponent(login)}`,{count:Number(count),...(audio==='inherit'?{}:{audioMode:audio})});
        toast.info('Подборка поставлена в очередь. Результаты появятся в черновиках.');
      }}>Подготовить черновики</JobButton>
    </div>
  </div>;
}
