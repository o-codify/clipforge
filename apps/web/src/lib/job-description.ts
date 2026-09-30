import type { JobRow } from "./api";
const actions: Record<string, string> = {
  "heavy.prepare-batch-vod":"Клипы эфира в подборке",
  "platform.discovery":"Поиск стримеров", "platform.metrics":"Обновление статистики публикаций", "platform.sweep":"Обход каналов и планирование",
  "heavy.pipeline": "Создание клипов из эфира", "heavy.prepare-preview": "Подготовка черновиков из эфира", "heavy.prepare-streamer": "Подборка клипов стримера", "heavy.fetch-vod": "Загрузка записи эфира",
  "heavy.transcribe-vod": "Распознавание речи", "heavy.analyze-vod": "Поиск ярких звуковых моментов",
  "heavy.facecam-vod": "Поиск камеры стримера", "heavy.render-run": "Монтаж вертикальных клипов", "heavy.render-variant": "Монтаж клипов с выбранной обработкой", "heavy.clean-clip":"Скрытие QR-кодов и рекламы", "heavy.inspect-ads":"Проверка рекламы эфира",
  "light.index-channel": "Поиск новых эфиров", "light.fetch-vod-info": "Обновление информации об эфире",
  "light.refresh-streamer": "Обновление профиля стримера", "light.publish-clip": "Публикация клипа", "light.publish-batch-clip": "Публикация клипа подборки",
  "light.refresh-youtube": "Проверка публикаций YouTube",
};
export const jobAction = (job: Pick<JobRow,"name">) => actions[job.name] ?? "Обработка материала";
export function jobNarration(job: JobRow) {
  const action = jobAction(job).toLocaleLowerCase();
  if (job.state === "active") {
    const stage = job.stage?.match(/шаг (\d)/)?.[1];
    const phrases:Record<string,string>={"1":"Загружаю запись и звук","2":"Слушаю эфир и распознаю речь","3":"Ищу яркие моменты по звуку","4":"Определяю положение камеры","5":"Монтирую вертикальные клипы"};
    return stage&&phrases[stage] ? `${phrases[stage]}.` : `Я выполняю: ${action}.`;
  }
  if (job.state === "completed") return `Я закончил: ${action}.`;
  if (job.state === "failed" || job.state === "expired") return `Не удалось закончить: ${action}. Нужна проверка администратора.`;
  if (job.state === "cancelled") return `Задание отменено: ${action}.`;
  if (job.state === "retry") return `Я повторю задание: ${action}.`;
  return `Следующее в очереди: ${action}.`;
}
