/**
 * Оценка кандидатов: кого имеет смысл подключить.
 *
 * Здесь формула, а не обученная модель, и это осознанно. Обучать пока
 * не на чем: у площадки нет ни одной опубликованной работы, а значит нет
 * и связи «взяли такого стримера - получили столько просмотров». Формула
 * на понятных сигналах честнее, чем модель, обученная на пустоте.
 *
 * Модуль сделан заменяемым: как только накопится история публикаций,
 * scoreCandidate уступит место обученной оценке, а всё остальное - отбор,
 * очередь, автоматика - останется как есть.
 *
 * Что известно про кандидата без единой загрузки:
 *   - зрители прямо сейчас;
 *   - фолловеры;
 *   - язык эфира;
 *   - просмотры прошлых записей.
 */

export interface CandidateSignals {
  viewers: number;
  followers: number;
  language: string;
  /** Средние просмотры последних архивов - есть ли жизнь после эфира. */
  archiveViews?: number;
  /** Сколько архивов вообще доступно: без них резать нечего. */
  archives?: number;
}

export interface CandidateScore {
  score: number;
  /** Почему столько - строка идёт в интерфейс рядом с кандидатом. */
  reason: string;
  parts: Record<string, number>;
}

export interface RankingOptions {
  /** Языки, с которыми работает площадка. */
  languages?: string[];
  /** Ниже этого числа зрителей клипы почти не собирают отклика. */
  minViewers?: number;
}

/** Логарифм с насыщением: рост от 100 к 1000 важнее, чем от 10000 к 11000. */
const saturate = (value: number, scale: number): number =>
  value <= 0 ? 0 : Math.min(1, Math.log10(1 + value) / Math.log10(1 + scale));

export function scoreCandidate(
  signals: CandidateSignals,
  options: RankingOptions = {},
): CandidateScore {
  const languages = options.languages ?? ["ru"];
  const minViewers = options.minViewers ?? 50;

  const parts: Record<string, number> = {
    // Зрители - самый прямой признак, что человека смотрят.
    viewers: saturate(signals.viewers, 10_000),
    // Фолловеры отделяют устойчивую аудиторию от случайного всплеска.
    followers: saturate(signals.followers, 200_000),
    // Просмотры архивов показывают, живёт ли контент после эфира.
    archiveViews: saturate(signals.archiveViews ?? 0, 5_000),
  };

  const weights = { viewers: 0.5, followers: 0.3, archiveViews: 0.2 };
  let score = Object.entries(weights).reduce(
    (sum, [name, weight]) => sum + weight * (parts[name] ?? 0),
    0,
  );

  const notes: string[] = [];
  if (signals.viewers > 0) notes.push(`${signals.viewers} зрителей`);
  if (signals.followers > 0) notes.push(`${signals.followers} фолловеров`);

  // Язык - не вес, а отсечка. Русские субтитры на английской речи это
  // не «чуть хуже», а неработающий клип.
  if (!languages.includes(signals.language)) {
    score = 0;
    notes.push(`язык ${signals.language || "неизвестен"} - не наш`);
  }

  // Нет архивов - резать нечего, сколько бы зрителей ни было.
  if (signals.archives !== undefined && signals.archives === 0) {
    score = 0;
    notes.push("нет архивов");
  }

  if (signals.viewers < minViewers && signals.followers < 10_000) {
    score *= 0.3;
    notes.push("мало зрителей");
  }

  return { score: Number(score.toFixed(4)), reason: notes.join(", "), parts };
}

/**
 * Сколько клипов делать по эфиру.
 *
 * Пока тоже формула: чем больше аудитория, тем больше смысла в объёме.
 * Когда появится статистика публикаций, отсюда будет видно, что у одних
 * стримеров заходят «реакции», а у других «бои» - и число станет
 * разным по типу триггера, а не одним на эфир.
 */
export function clipBudget(
  signals: CandidateSignals,
  options: { base?: number; max?: number } = {},
): number {
  const base = options.base ?? 12;
  const max = options.max ?? 40;
  const scale = 1 + saturate(Math.max(signals.viewers, signals.followers / 20), 20_000);
  return Math.min(max, Math.round(base * scale));
}
