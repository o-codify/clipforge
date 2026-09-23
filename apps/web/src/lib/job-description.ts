import type { JobRow } from "./api";
const actions: Record<string, string> = {
  "heavy.pipeline": "Создание клипов из эфира", "heavy.fetch-vod": "Загрузка записи эфира",
  "heavy.transcribe-vod": "Распознавание речи", "heavy.analyze-vod": "Поиск ярких звуковых моментов",
  "heavy.facecam-vod": "Поиск камеры стримера", "heavy.render-run": "Монтаж вертикальных клипов",
  "light.index-channel": "Поиск новых эфиров", "light.fetch-vod-info": "Обновление информации об эфире",
  "light.refresh-streamer": "Обновление профиля стримера", "light.publish-clip": "Публикация клипа",
};
export const jobAction = (job: JobRow) => actions[job.name] ?? "Обработка материала";
export function jobNarration(job: JobRow) {
  const action = jobAction(job).toLocaleLowerCase();
  const who = job.streamerName ? ` · ${job.streamerName}` : "";
  if (job.state === "active") {
    const stage = job.stage?.match(/шаг (\d)/)?.[1];
    const phrases:Record<string,string>={"1":"Загружаю запись и звук","2":"Слушаю эфир и распознаю речь","3":"Ищу яркие моменты по звуку","4":"Определяю положение камеры","5":"Монтирую вертикальные клипы"};
    return stage&&phrases[stage] ? `${phrases[stage]}${who}.` : `Я выполняю: ${action}${who}.`;
  }
  if (job.state === "completed") return `Я закончил: ${action}${who}.`;
  if (job.state === "failed" || job.state === "expired") return `Не удалось закончить: ${action}${who}. Нужна проверка администратора.`;
  if (job.state === "cancelled") return `Задание отменено: ${action}${who}.`;
  if (job.state === "retry") return `Я повторю задание: ${action}${who}.`;
  return `Следующее в очереди: ${action}${who}.`;
}
