import { narrateEvent } from "./narration.js";

interface Job {
  id:string; name:string; state:string; data:Record<string,unknown>; createdAt:string;
  output:unknown; objectTitle?:unknown; objectHref?:unknown; streamerName?:unknown; streamer?:unknown;
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
  const completions:Record<string,string>={
    "heavy.pipeline":"Закончил обработку эфира. Готовые клипы можно посмотреть здесь.",
    "heavy.prepare-preview":"Подготовил черновики клипов. Они сохранены для просмотра.",
    "heavy.render-run":"Закончил монтаж клипов.","heavy.render-variant":"Подготовил клип с выбранной обработкой.","heavy.fetch-vod":"Загрузил запись эфира.",
    "heavy.clean-clip":"Скрыл рекламу в новой версии клипа.",
    "heavy.inspect-ads":"Проверил кадры эфира и сохранил расположение рекламы для нарезки.",
    "heavy.transcribe-vod":"Распознал речь в эфире.","heavy.analyze-vod":"Проверил звук и нашёл моменты для отбора.",
    "heavy.facecam-vod":output?.found?"Нашёл камеру стримера.":"Не нашёл камеру в проверенных кадрах.",
    "light.index-channel":"Проверил записи канала и обновил список эфиров.",
    "light.fetch-vod-info":"Обновил информацию об эфире.","light.refresh-streamer":"Обновил профиль стримера.",
    "light.publish-clip":"Завершил задание публикации. Результат можно проверить в карточке клипа.",
    "light.refresh-youtube":"Проверил видимость видео, ограничения и обновил статистику YouTube.",
  };
  const text=complete ? completions[job.name]??"Закончил задание. Результаты сохранены."
    : failed ? "Не смог завершить задание. Посмотреть причину можно в разделе заданий."
    : job.state==="cancelled" ? "Остановил обработку. Уже готовые материалы сохранены."
    : job.state==="retry" ? "Повторю обработку после паузы. Уже готовые материалы сохранены."
    : job.state==="created" ? "Добавил задание в очередь. Начну, когда дойдёт его очередь."
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
    streamer: typeof job.streamer==='string'?job.streamer:typeof job.data.login==='string'?job.data.login:undefined,
    context:job.objectHref?.toString().startsWith('/vods/')?String(job.objectTitle??''):undefined,facts,
    steps:["heavy.pipeline","heavy.prepare-preview"].includes(job.name) ? ["Загрузка","Речь","Анализ","Камера","Монтаж"].map((label,index)=>({label,state:complete||index+1<stage?"done":index+1===stage?failed?"error":"active":"waiting"})) : [],
    actions:job.objectHref?[{id:complete&&job.data.vodId?`clips:${job.data.vodId}`:String(job.objectHref),label:complete&&job.data.vodId?"Клипы в чате":job.data.login?"Открыть канал":"Открыть эфир"}]:[],
    tone:failed?"error":complete?"success":"normal",
    ...(admin?{technical:`job: ${job.id}\nqueue: ${job.name}\n${logs.slice(-12).join("\n")}`}:{})
  };
}
