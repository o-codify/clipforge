import { narrateEvent } from "./narration.js";

interface Job {
  id:string; name:string; state:string; data:Record<string,unknown>; createdAt:string;
  output:unknown; objectTitle?:unknown; objectHref?:unknown; streamerName?:unknown;
}
export function jobMessage(job:Job, events:{message:string}[], admin:boolean) {
  const logs=events.map(event=>event.message.trim());
  const stage=logs.reduce((value,line)=>Number(line.match(/^шаг (\d)\/5/)?.[1]??value),0);
  const rendered=new Set(logs.flatMap(line=>{
    const match=line.match(/^\[(\d+)\/(\d+)\]/);
    return match&&!line.includes("СБОЙ")?[match[1]]:[];
  }));
  const total=logs.reduce((value,line)=>Number(line.match(/^\[\d+\/(\d+)\]/)?.[1]??value),0);
  const output=job.output as Record<string,unknown>|null;
  const complete=job.state==="completed";
  const failed=["failed","expired"].includes(job.state);
  const latest=[...logs].reverse().map(narrateEvent).find(Boolean);
  const text=complete ? job.name==="heavy.pipeline"||job.name==="heavy.render-run" ? "Клипы готовы. Обработка эфира завершена." : "Проверка завершена. Информация обновлена."
    : failed ? "Не удалось завершить обработку. Готовые материалы сохранены; подробности доступны администратору."
    : job.state==="cancelled" ? "Обработка остановлена. Готовые материалы сохранены."
    : job.state==="retry" ? "Повторю обработку после паузы. Уже готовые материалы сохранены."
    : job.state==="created" ? "Эфир в очереди на обработку."
    : rendered.size ? `Монтирую клипы: готово ${rendered.size} из ${total}.`
    : latest??"Начинаю обработку материала.";
  const facts:{label:string;value:string}[]=[];
  if(complete&&typeof output?.rendered==="number")facts.push({label:"Создано клипов",value:String(output.rendered)});
  else if(total)facts.push({label:"Готово",value:`${rendered.size} / ${total}`});
  if(complete&&typeof output?.found==="number")facts.push({label:"Эфиров",value:String(output.found)});
  const candidates=logs.map(line=>line.match(/^кандидатов (\d+)/)?.[1]).find(Boolean);
  if(candidates)facts.push({label:"Найдено моментов",value:candidates});
  return {
    id:`work-${job.data.vodId?`vod:${job.data.vodId}`:job.data.login?`channel:${job.data.login}`:job.id}`,
    time:new Date(job.createdAt).toISOString(),text,
    context:[...new Set([job.streamerName,job.objectTitle].filter(Boolean))].join(" · "),facts,
    steps:job.name==="heavy.pipeline" ? ["Загрузка","Речь","Анализ","Камера","Монтаж"].map((label,index)=>({label,state:complete||index+1<stage?"done":index+1===stage?failed?"error":"active":"waiting"})) : [],
    actions:job.objectHref?[{id:complete&&job.data.vodId?`clips:${job.data.vodId}`:String(job.objectHref),label:complete&&job.data.vodId?"Клипы в чате":job.data.login?"Открыть канал":"Открыть эфир"}]:[],
    tone:failed?"error":complete?"success":"normal",
    ...(admin?{technical:`job: ${job.id}\nqueue: ${job.name}\n${logs.slice(-12).join("\n")}`}:{})
  };
}
