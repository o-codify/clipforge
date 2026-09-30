import { readFile,stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PlatformClient } from './client.js';

export const HELP=`ClipForge — управление через API платформы

pnpm cf accounts                         подключённые каналы
pnpm cf youtube-check [accountId]        проверить авторизацию канала
pnpm cf clips [--streamer login]         найти клипы
pnpm cf clip <clipId>                    клип, проверка рекламы, публикации
pnpm cf run <runId>                      результат нарезки и параметры обработки
pnpm cf streamer <login>                 профиль и настройка звука
pnpm cf streamer-audio <login> --audio original|dtln|dtln-gated
                                        звук новых клипов всех эфиров стримера
pnpm cf vod-audio <vodId> --audio inherit|original|dtln|dtln-gated
                                        звук новых клипов конкретного эфира
pnpm cf render <vodId> [--count 1] [--fresh] [--audio dtln] [--test-batch]
                                        создать клип; --fresh выбирает другой момент
                                        --test-batch: до 100 разных черновиков даже в режиме разработки
pnpm cf prepare-streamer <login> --count 100 --audio dtln-gated [--vods id,id]
                                        подборка из разных эфиров, только черновики
pnpm cf streamer-ads <login> --ads on|off [--all]
                                        проверка рекламы; --all также сбрасывает настройки всех эфиров
pnpm cf vod-ads <vodId> --ads on|off|inherit
                                        проверка рекламы отдельного эфира
pnpm cf prepare <vodId> [--count 1] [--audio dtln]
                                        скачать и обработать эфир; только новые черновики, без публикации
pnpm cf preview <clipId>                 готовые название, описание, каналы
pnpm cf publish <clipId> --metadata file.json
                                        отправить клип через очередь
pnpm cf publication <publicationId>      сохранённая видимость, ограничения, счётчики
pnpm cf refresh [publicationId]          заказать проверку YouTube без загрузки
pnpm cf analytics [--page N]             статистика публикаций
pnpm cf jobs                            последние задания
pnpm cf active                          задания в очереди и в работе
pnpm cf vod <vodId>                     эфир и готовые клипы
pnpm cf job <jobId>                      состояние задания
pnpm cf cancel <jobId>                   отменить задание
pnpm cf wait <jobId> [--timeout 120]      дождаться задания (секунды, максимум 900)
pnpm cf cleanup <clipId> [--regions file.json]
                                        скрыть QR-коды и рекламу через очередь
pnpm cf inspect-ads <vodId>              автоматически проверить кадры и сохранить карту рекламы эфира
pnpm cf approve-clip <clipId>            подтвердить просмотр результата скрытия рекламы
pnpm cf draft-clip <clipId>              вернуть клип в черновики

Адрес: --url https://clipforge.example или CLIPFORGE_URL (обязателен).
Вход: CLIPFORGE_LOGIN + CLIPFORGE_PASSWORD; временная сессия закрывается после команды.
Либо CLIPFORGE_SESSION — готовая сессия выбранной платформы, она не закрывается.
Пароли и сессии не передаются аргументами и не сохраняются клиентом.
Результат — JSON. GET не запускает обновление или загрузку.
Повтор publish возвращает существующую публикацию, а не загружает её заново.
`;

type Plan={path:string;method?:string;body?:unknown;waitSeconds?:number};
export function parseCommand(args:string[]) {
  return parseArgs({args,allowPositionals:true,strict:true,options:{
    help:{type:'boolean'},url:{type:'string'},streamer:{type:'string'},page:{type:'string'},limit:{type:'string'},
    metadata:{type:'string'},regions:{type:'string'},timeout:{type:'string'},
    count:{type:'string'},fresh:{type:'boolean'},audio:{type:'string'},'test-batch':{type:'boolean'},
    ads:{type:'string'},all:{type:'boolean'},vods:{type:'string'},
  }});
}
function integer(value:string|undefined,fallback:number,max:number) {
  const number=value===undefined?fallback:Number(value);
  if(!Number.isInteger(number)||number<1||number>max) throw new Error(`Ожидается целое число от 1 до ${max}`);
  return number;
}
async function jsonFile(path:string|undefined) {
  if(!path)throw new Error('Укажите JSON-файл параметров');
  if((await stat(path)).size>65536)throw new Error('JSON-файл слишком большой');
  return JSON.parse(await readFile(path,'utf8')) as unknown;
}

export async function commandPlan(parsed:ReturnType<typeof parseCommand>):Promise<Plan> {
  const [command,target,...extra]=parsed.positionals;
  const options=parsed.values;
  const noTarget=['accounts','clips','analytics','jobs','active'];
  const optionalTarget=['youtube-check','refresh'];
  const targets=['clip','run','vod','streamer','streamer-audio','vod-audio','streamer-ads','vod-ads','render','prepare','prepare-streamer','preview','publish','publication','job','cancel','wait','cleanup','inspect-ads','approve-clip','draft-clip'];
  if(!command||![...noTarget,...optionalTarget,...targets].includes(command))throw new Error('Неизвестная команда. Используйте pnpm cf --help');
  if(extra.length||(noTarget.includes(command)&&target)||(targets.includes(command)&&!target))throw new Error('Неверное число аргументов команды');
  const allowed:Record<string,string[]>={clips:['streamer','limit'],render:['count','fresh','audio','test-batch'],prepare:['count','audio'],'prepare-streamer':['count','audio','vods'],'streamer-ads':['ads','all'],'vod-ads':['ads'],'streamer-audio':['audio'],'vod-audio':['audio'],analytics:['page'],publish:['metadata'],cleanup:['regions'],wait:['timeout']};
  for(const key of Object.keys(options))if(!['url','help',...(allowed[command]??[])].includes(key))throw new Error(`Параметр --${key} не относится к команде ${command}`);
  const id=encodeURIComponent(target??'');
  switch(command) {
    case 'accounts':return {path:'/api/platforms'};
    case 'youtube-check':return {path:'/api/platforms/youtube/check',method:'POST',body:target?{accountId:target}:{}};
    case 'clips': {
      const query=new URLSearchParams({limit:String(integer(options.limit,30,100))});
      if(options.streamer)query.set('streamer',options.streamer);
      return {path:`/api/clips?${query}`};
    }
    case 'clip':return {path:`/api/clips/${id}`};
    case 'run':return {path:`/api/runs/${id}`};
    case 'streamer':return {path:`/api/streamers/${id}`};
    case 'streamer-ads':
    case 'vod-ads': {
      const values=command==='vod-ads'?['on','off','inherit']:['on','off'];
      if(!options.ads||!values.includes(options.ads))throw new Error('--ads: '+values.join(', '));
      return {path:`/api/${command==='vod-ads'?'vods':'streamers'}/${id}/ads`,method:'POST',body:{enabled:options.ads==='inherit'?null:options.ads==='on',...(command==='streamer-ads'?{applyToAll:options.all??false}:{})}};
    }
    case 'streamer-audio':
    case 'vod-audio': {
      const modes=command==='vod-audio'?['original','dtln','dtln-gated','inherit']:['original','dtln','dtln-gated'];
      if(!options.audio||!modes.includes(options.audio))throw new Error('--audio: '+modes.join(', '));
      return {path:`/api/${command==='vod-audio'?'vods':'streamers'}/${id}/audio`,method:'POST',body:{audioMode:options.audio==='inherit'?null:options.audio}};
    }
    case 'render': {
      if(options.audio&&!['original','dtln','dtln-gated'].includes(options.audio))throw new Error('--audio: original или dtln');
      return {path:`/api/jobs/render/${id}`,method:'POST',body:{count:integer(options.count,1,options['test-batch']?100:200),
        ...(options.fresh||options['test-batch']?{skipExisting:true}:{}),...(options.audio?{audioMode:options.audio}:{}),
        ...(options['test-batch']?{testBatch:true}:{})}};
    }
    case 'prepare': {
      if(options.audio&&!['original','dtln','dtln-gated'].includes(options.audio))throw new Error('--audio: original или dtln');
      return {path:`/api/jobs/prepare/${id}`,method:'POST',body:{count:integer(options.count,1,100),...(options.audio?{audioMode:options.audio}:{})}};
    }
    case 'prepare-streamer': {
      if(options.audio&&!['original','dtln','dtln-gated'].includes(options.audio))throw new Error('--audio: original, dtln, dtln-gated');
      const vodIds=options.vods?.split(',').map(s=>s.trim());
      if(vodIds&&(vodIds.length<2||vodIds.length>20||vodIds.some(s=>!s)||new Set(vodIds).size!==vodIds.length))throw new Error('--vods: от 2 до 20 разных эфиров через запятую');
      return {path:`/api/jobs/prepare-streamer/${id}`,method:'POST',body:{count:integer(options.count,100,100),...(options.audio?{audioMode:options.audio}:{}),...(vodIds?{vodIds}:{})}};
    }
    case 'preview':return {path:`/api/platforms/publish/${id}`};
    case 'publish':return {path:`/api/platforms/publish/${id}`,method:'POST',body:await jsonFile(options.metadata)};
    case 'publication':return {path:`/api/platforms/publications/${id}`};
    case 'refresh':return {path:'/api/platforms/youtube/refresh',method:'POST',body:target?{publicationId:target}:{}};
    case 'analytics':return {path:`/api/operations/analytics/videos?page=${integer(options.page,1,1000)}`};
    case 'jobs':return {path:'/api/jobs?limit=30'};
    case 'active':return {path:'/api/jobs/active'};
    case 'vod':return {path:`/api/vods/${id}`};
    case 'job':return {path:`/api/jobs/${id}/status`};
    case 'cancel':return {path:`/api/jobs/cancel/${id}`,method:'POST',body:{}};
    case 'wait':return {path:`/api/jobs/${id}/status`,waitSeconds:integer(options.timeout,120,900)};
    case 'cleanup':return {path:`/api/jobs/clean-clip/${id}`,method:'POST',body:{regions:options.regions?await jsonFile(options.regions):[]}};
    case 'inspect-ads':return {path:`/api/jobs/inspect-ads/${id}`,method:'POST',body:{}};
    case 'approve-clip':return {path:`/api/clips/${id}/state`,method:'POST',body:{state:'ready',reviewed:true}};
    case 'draft-clip':return {path:`/api/clips/${id}/state`,method:'POST',body:{state:'draft'}};
    default:throw new Error('Неизвестная команда');
  }
}

export async function execute(client:PlatformClient,plan:Plan) {
  if(!plan.waitSeconds)return {result:await client.request(plan.path,plan.method,plan.body),exitCode:0};
  const deadline=Date.now()+plan.waitSeconds*1000;
  let delay=5000;
  while(true) {
    const job=await client.request<{state:string}>(plan.path);
    if(['completed','failed','expired','cancelled'].includes(job.state))return {result:job,exitCode:job.state==='completed'?0:1};
    if(Date.now()>=deadline)return {result:{...job,timedOut:true},exitCode:2};
    await new Promise(resolve=>setTimeout(resolve,Math.min(delay,deadline-Date.now())));
    delay=Math.min(delay+2500,15000);
  }
}
