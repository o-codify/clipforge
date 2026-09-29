"use client";
import { StreamerBadge } from "@/components/StreamerBadge";
import { useSession } from "@/lib/session";

/**
 * Страница эфира.
 *
 * Отвечает на четыре вопроса по порядку, в котором они возникают:
 *   1. что это за эфир;
 *   2. на каком он шаге и что уже получено;
 *   3. сколько моментов в нём нашлось и каких;
 *   4. что из этого уже нарезано.
 *
 * Число клипов здесь не спрашивается. Площадка режет столько, сколько
 * нашла триггеров - в этом весь смысл: получить много клипов разного
 * содержания и потом сравнить их по статистике. Поле «12» ничего не
 * значило и противоречило замыслу.
 */
import Link from "next/link";
import { NavigationRow } from "@/components/NavigationRow";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Card, JobButton, PageSkeleton, Pill, SectionTitle } from "@/components/ui";
import { api, hhmm, runTime, TRIGGERS, when } from "@/lib/api";
import { useJobs, useLiveReload } from "@/lib/jobs";
import {AudioSetting,type VodAudioSettings} from '@/components/AudioSetting';

interface VodDetail {
  id: string;
  audio: VodAudioSettings;
  adProtection?: {complete:boolean;samples:number;regions:unknown[]}|null;
  streamer: string;
  game: string | null;
  title: string | null;
  duration: number | null;
  state: string;
  error: string | null;
  chapters: { title: string; start: number; end: number }[];
  facecam: { found: boolean; note: string } | null;
  signals: { frames: number; duration: number } | null;
  publishedAt: string | null;
  transcript: {
    language: string; model: string; segments: number; droppedLoops: number;
  } | null;
  runs: {
    id: string; version: string; candidates: number; clips: number;
    startedAt: string; settings: Record<string, unknown>;
  }[];
}

interface Preview {
  ready: boolean;
  missing: string[];
  total: number;
  byTrigger: { trigger: string; count: number }[];
  perHour: number;
  seconds: number;
}

/** Шаги конвейера в том порядке, в котором они выполняются. */
const STEPS = [
  { key: "sources", title: "Исходники", hint: "Аудио и видео эфира" },
  { key: "transcript", title: "Расшифровка речи", hint: "Пословные таймкоды" },
  { key: "signals", title: "Сигналы звука", hint: "Громкость, атаки, бой" },
  { key: "facecam", title: "Поиск камеры", hint: "Где в кадре стример" },
] as const;

export default function VodPage() {
  const { id } = useParams<{ id: string }>();
  const { activeFor } = useJobs();

  const [vod, setVod] = useState<VodDetail | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const { viewer } = useSession();

  // Есть ли вообще работа по эфиру: пока идёт одна, вторую не начать.
  const anyJob = activeFor(id);

  const load = useCallback(() => {
    void api.get<VodDetail>(`/api/vods/${id}`).then(setVod);
    void api
      .get<Preview>(`/api/vods/${id}/candidates`)
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [id]);

  // Данные обновляются сами: пока идёт нарезка, счётчики прогонов и
  // клипов меняются прямо на странице, без ручного обновления.
  useLiveReload(load);

  if (!vod) return <PageSkeleton />;

  const done: Record<string, boolean> = {
    sources: vod.state === "ready",
    transcript: Boolean(vod.transcript),
    signals: Boolean(vod.signals),
    facecam: Boolean(vod.facecam),
  };
  const detail: Record<string, string> = {
    sources: vod.state === "ready" ? "Запись готова" : viewer?.isAdmin ? vod.error ?? "" : "",
    transcript: vod.transcript
      ? `${vod.transcript.segments} фраз${viewer?.isAdmin?` · модель ${vod.transcript.model}`:""}`
      : "",
    signals: vod.signals ? viewer?.isAdmin?`${vod.signals.frames.toLocaleString("ru-RU")} кадров`:"Звук проанализирован" : "",
    facecam: vod.facecam ? viewer?.isAdmin?vod.facecam.note:(vod.facecam.found?"Камера найдена":"Отдельная камера не используется") : "",
  };
  const readySteps = STEPS.filter((step) => done[step.key]).length;
  // Пока по эфиру идёт работа, первый незавершённый шаг показывает её
  // собой: вместо номера крутится кольцо. Блок существует всегда, его
  // размеры не меняются - анимация живёт внутри ячейки.
  const activeStep = anyJob?.startedAt
    ? STEPS.find((step) => !done[step.key])?.key ?? null
    : null;

  return (
    <>
      <div className="crumbs">
        <Link href="/">Обзор</Link>
        <span>/</span>
        <StreamerBadge login={vod.streamer}/>
        <span>/</span>
        <b>Запись эфира</b>
      </div>

      <div className="page-head">
        <div>
          <h2 className="detail-title">{vod.title ?? "Эфир без названия"}</h2>
          <p className="sub">
            {hhmm(vod.duration)} · эфир {when(vod.publishedAt)}
            {vod.game && (
              <>
                {" · "}
                <Link href={`/games/${vod.game}`}>{vod.game}</Link>
              </>
            )}
            {" · "}
            <a
              href={`https://twitch.tv/videos/${vod.id.replace(/^v/, "")}`}
              target="_blank"
              rel="noopener"
            >
              Открыть на Twitch
            </a>
          </p>
        </div>

        <div className="page-actions">
          {/* Кнопка сама показывает ход задания и не меняет геометрию
              страницы. Загрузка исходников - первый шаг конвейера. */}
          <JobButton
            target={vod.id}
            kinds={["pipeline", "render-run", "render-variant", "transcribe-vod", "analyze-vod", "facecam-vod"]}
            variant="primary"
            icon="✂"
            disabled={Boolean(anyJob)}
            onRun={() => api.post(`/api/jobs/pipeline/${vod.id}`, {})}
          >
            {preview?.ready && preview.total > 0
              ? `Нарезать ${preview.total} моментов`
              : "Нарезать клипы"}
          </JobButton>
        </div>
      </div>

      {viewer?.isAdmin&&vod.audio&&<Card><AudioSetting scope="vod" id={id} value={vod.audio.override} streamerMode={vod.audio.streamerMode} onSaved={load}/></Card>}
      {viewer?.isAdmin&&<Card><h3>QR-коды и реклама</h3>
        <p>{vod.adProtection?.complete
          ? `Карта эфира готова · ${vod.adProtection.samples} кадров · областей: ${vod.adProtection.regions.length}`
          : 'Проверка кадров и скрытие рекламы выполняются автоматически перед нарезкой.'}</p>
      </Card>}

      <SectionTitle aside={<span className="muted">{readySteps} из {STEPS.length}</span>}>
        Подготовка
      </SectionTitle>
      <div className="steps">
        {STEPS.map((step, index) => {
          const isActive = step.key === activeStep;
          return (
            <div
              key={step.key}
              className={
                "step" +
                (done[step.key] ? " step-done" : "") +
                (isActive ? " step-active" : "")
              }
            >
              <span className="step-mark">{done[step.key] ? "✓" : index + 1}</span>
              <div className="step-body">
                <b>{step.title}</b>
                <span className="muted">
                  {isActive ? "Выполняется…" : detail[step.key] || step.hint}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <SectionTitle
        aside={
          preview?.ready ? (
            <span className="muted">
              {preview.perHour} в час · суммарно {hhmm(preview.seconds)}
            </span>
          ) : null
        }
      >
        Найденные моменты
      </SectionTitle>

      {!preview ? (
        <Card className="empty">Не удалось посчитать моменты.</Card>
      ) : !preview.ready ? (
        <Card className="empty">
          Пока нечего считать: не хватает {preview.missing.join(", ")}.
          <br />
          <span className="muted">
            Нажмите «Нарезать» — недостающие шаги выполнятся сами, по порядку.
          </span>
        </Card>
      ) : (
        <div className="triggers">
          <div className="trigger trigger-total">
            <b>{preview.total}</b>
            <span>Моментов</span>
          </div>
          {preview.byTrigger.map((row) => (
            <div className="trigger" key={row.trigger}>
              <b>{row.count}</b>
              <span>{TRIGGERS[row.trigger] ?? row.trigger}</span>
              <i style={{ width: `${(row.count / preview.total) * 100}%` }} />
            </div>
          ))}
        </div>
      )}

      {vod.chapters.length > 0 && (
        <>
          <SectionTitle>Игры в эфире</SectionTitle>
          <div className="chapters">
            {vod.chapters.map((chapter, index) => (
              <div className="chapter" key={index}>
                <b>{chapter.title}</b>
                <span className="muted">
                  {hhmm(chapter.start)} – {hhmm(chapter.end)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Прогоны</SectionTitle>
      {vod.runs.length === 0 ? (
        <Card className="empty">Нарезок ещё не было.</Card>
      ) : (
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>Прогон</th>
                <th className="num">Клипов</th>
                <th className="num">Кандидатов</th>
                {viewer?.isAdmin&&<th>Оформление</th>}
                <th>Когда</th>
              </tr>
            </thead>
            <tbody>
              {vod.runs.map((run) => (
                <NavigationRow key={run.id} href={`/runs/${run.id}`} label={runTime(run.id)}>
                  <td className="num">{run.clips}</td>
                  <td className="num">{run.candidates}</td>
                  {viewer?.isAdmin&&<td>
                    <Pill>{run.version || "—"}</Pill>
                  </td>}
                  <td className="muted">{when(run.startedAt)}</td>
                </NavigationRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
