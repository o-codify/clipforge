"use client";
import {useState} from 'react';
import {api} from '@/lib/api';
import {Select} from './Select';
import {JobButton} from './ui';
import {BatchPublications} from './BatchPublications';

export function GamePreview({vodId,login,chapters}:{vodId:string;login:string;chapters:{title:string}[]}) {
  const options=[...new Set(chapters.map(c=>c.title))].map(title=>({label:title,value:title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'_').replace(/^_|_$/g,'')}));
  const [game,setGame]=useState(options[0]?.value??''),[count,setCount]=useState('5'),[batch,setBatch]=useState('');
  const [from,setFrom]=useState(''),[to,setTo]=useState('');
  const ranged=from!==''||to!=='';
  const rangeValid=!ranged||(from!==''&&to!==''&&Number(from)>=0&&Number(to)>Number(from)&&Number(to)-Number(from)<=90);
  if(!options.length)return null;
  return <div className="audio-setting"><h3>Клипы по игре</h3><div className="audio-setting-control" style={{gap:12,flexWrap:'wrap'}}>
    <Select label="Игра для клипов" value={game} onValueChange={setGame} options={options}/>
    <label>Клипов <input className="field" type="number" aria-label="Количество клипов по игре" min={1} max={100} value={count} onChange={e=>setCount(e.target.value)} style={{width:85}}/></label>
    <label>С минуты <input className="field" type="number" min={0} value={from} onChange={e=>setFrom(e.target.value)} style={{width:100}}/></label>
    <label>До минуты <input className="field" type="number" min={0} value={to} onChange={e=>setTo(e.target.value)} style={{width:100}}/></label>
    <JobButton target={vodId} kinds={['prepare-preview']} disabled={!game||!rangeValid||!Number.isInteger(Number(count))||Number(count)<1||Number(count)>100} onRun={async()=>{const job=await api.post<{id:string}>(`/api/jobs/prepare/${vodId}`,{game,count:Number(count),...(ranged?{sourceRange:{start:Number(from)*60,end:Number(to)*60}}:{})});setBatch(job.id);return job;}}>Подготовить клипы</JobButton>
  </div><p className="muted">Отрезок внутри выбранной игры, до 90 минут. Если границы не указаны — первая глава. Публикация включается отдельно.</p>
    {batch&&<BatchPublications login={login} batchId={batch}/>}
  </div>;
}
