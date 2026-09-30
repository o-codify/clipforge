import {readFile} from 'node:fs/promises';
import {createSign} from 'node:crypto';

/** YouTube daily project quotas reset at midnight Los Angeles, including DST. */
export function quotaDay(now=new Date()) {
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const midnight=(day:string)=>{let t=Date.parse(day+'T00:00:00Z');for(let i=0;i<3;i++){
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',timeZoneName:'longOffset'}).formatToParts(new Date(t));
    const offset=parts.find(p=>p.type==='timeZoneName')!.value.match(/GMT([+-])(\d+):(\d+)/)!;
    t=Date.parse(day+'T00:00:00Z')-(offset[1]==='-'?-1:1)*(Number(offset[2])*60+Number(offset[3]))*60000;
  }return new Date(t).toISOString();};
  const tomorrow=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  return {start:midnight(date),resetAt:midnight(tomorrow)};
}
export interface CloudQuota {state:'ok'|'unavailable';limit:number|null;used:number|null;remaining:number|null;checkedAt:string;usageThrough?:string;resetAt:string;start:string;project:string|null;reason?:string;}
async function credentialToken(file:string):Promise<string>{
  const c=JSON.parse(await readFile(file,'utf8'));
  let body:URLSearchParams;
  if(c.type==='service_account'){
    const enc=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');
    const now=Math.floor(Date.now()/1000),message=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iss:c.client_email,scope:'https://www.googleapis.com/auth/cloud-platform.read-only',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
    const signature=createSign('RSA-SHA256').update(message).sign(c.private_key,'base64url');
    body=new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:message+'.'+signature});
  }else if(c.type==='authorized_user')body=new URLSearchParams({grant_type:'refresh_token',client_id:c.client_id,client_secret:c.client_secret,refresh_token:c.refresh_token});
  else throw new Error('Тип учётных данных Cloud не поддерживается');
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body,signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Нет доступа к Google Cloud');
  const token=await response.json() as {access_token:string};return token.access_token;
}
export async function cloudUploadQuota(env=process.env,now=new Date()):Promise<CloudQuota>{
  const result:CloudQuota={state:'unavailable',limit:null,used:null,remaining:null,checkedAt:now.toISOString(),...quotaDay(now),project:env.GOOGLE_CLOUD_PROJECT??null};
  if(!env.GOOGLE_APPLICATION_CREDENTIALS||!result.project)return {...result,reason:'Не подключено чтение квоты Google Cloud'};
  try{
    const token=await credentialToken(env.GOOGLE_APPLICATION_CREDENTIALS);
    const get=async(url:string)=>{const r=await fetch(url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Google Cloud: ${r.status}`);return r.json() as Promise<any>;};
    const metrics:any[]=[];let page='';
    do{const data=await get(`https://serviceusage.googleapis.com/v1beta1/projects/${encodeURIComponent(result.project)}/services/youtube.googleapis.com/consumerQuotaMetrics?view=FULL&pageSize=200&pageToken=${encodeURIComponent(page)}`);metrics.push(...(data.metrics??[]));page=data.nextPageToken??'';}while(page);
    const metric=metrics.find(m=>/video.*upload|upload.*video/i.test(m.displayName??'')||/videos_insert|video_upload/i.test(m.metric??''));
    const quota=metric?.consumerQuotaLimits?.find((l:any)=>/\/d(?:\/|$)/.test(l.unit));
    const buckets=quota?.quotaBuckets?.filter((b:any)=>!Object.keys(b.dimensions??{}).length)??[];
    if(buckets.length!==1)throw new Error('Квота загрузок не найдена');
    const limit=Number(buckets[0].effectiveLimit);
    if(!Number.isSafeInteger(limit)||limit<0)throw new Error('Квота загрузок не определена');
    const query=new URLSearchParams({filter:`metric.type="serviceruntime.googleapis.com/quota/rate/net_usage" AND resource.type="consumer_quota" AND resource.labels.service="youtube.googleapis.com" AND metric.labels.quota_metric="${metric.metric}"`,
      'interval.startTime':result.start,'interval.endTime':now.toISOString(),view:'FULL',pageSize:'1000'});
    let used=0,seen=false,usageThrough=result.start;page='';
    do{query.set('pageToken',page);const data=await get(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(result.project)}/timeSeries?${query}`);
      for(const series of data.timeSeries??[]){
        if(series.metricKind!=='DELTA')throw new Error('Неизвестный тип счётчика расхода');
        for(const point of series.points??[]){const n=Number(point.value?.int64Value??point.value?.doubleValue);if(!Number.isFinite(n)||n<0)throw new Error('Неизвестное значение расхода');used+=n;seen=true;
          if(Date.parse(point.interval?.endTime)>Date.parse(usageThrough))usageThrough=point.interval.endTime;
        }
      }
      page=data.nextPageToken??'';
    }while(page);
    // An absent time series is not proof of zero use (collection can be unavailable).
    return {...result,state:seen?'ok':'unavailable',limit,used:seen?used:null,remaining:seen?Math.max(0,limit-used):null,usageThrough,reason:seen?undefined:'Google Cloud пока не вернул расход квоты'};
  }catch(error){return {...result,reason:error instanceof Error?error.message:'Квота недоступна'};}
}
