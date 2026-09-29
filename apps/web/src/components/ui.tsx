"use client";
import { useSession } from "@/lib/session";

/**
 * Общие элементы интерфейса.
 *
 * Кнопки собраны в одном месте намеренно: пока каждая страница верстала
 * их сама, они разъехались - разные размеры, разные отступы, подписи то
 * с большой буквы, то с маленькой. Здесь один набор вариантов, и новая
 * страница не может случайно нарисовать пятую разновидность.
 *
 * Главный принцип обратной связи: действие показывает себя ВНУТРИ того
 * элемента, который его запустил. Кнопка сама становится «в очереди»,
 * потом «идёт 0:42» - той же высоты, на том же месте. Никаких надписей,
 * вставленных в страницу: от них дёргается всё, что ниже.
 */
import { useEffect, useState } from "react";

import { useJobs } from "@/lib/jobs";
import { toast } from "@/lib/toast";

type Variant = "primary" | "default" | "ghost" | "danger";
type Size = "md" | "sm";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Действие выполняется: кнопка блокируется и показывает это собой. */
  busy?: boolean;
  icon?: string;
  /**
   * Другие варианты подписи этой кнопки.
   *
   * Кнопка-переключатель («Автоматика включена» / «выключена») меняет
   * текст, а с ним и ширину - и всё вокруг дёргается. Призраки всех
   * вариантов резервируют ширину под самый длинный раз и навсегда.
   */
  reserve?: React.ReactNode[];
}

export function Button({
  variant = "default",
  size = "md",
  busy = false,
  icon,
  reserve,
  children,
  disabled,
  className = "",
  ...rest
}: ButtonProps) {
  const content = (
    <>
      {busy ? <span className="spinner" /> : icon ? <span className="btn-icon">{icon}</span> : null}
      <span>{children}</span>
    </>
  );
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={`btn btn-${variant} btn-${size}${busy ? " btn-busy" : ""} ${className}`}
    >
      {reserve && reserve.length > 0 ? (
        <span className="btn-stack">
          {reserve.map((ghost, index) => (
            <span key={index} className="btn-reserve" aria-hidden>
              {icon && <span className="btn-icon">{icon}</span>}
              <span>{ghost}</span>
            </span>
          ))}
          <span className="btn-layer">{content}</span>
        </span>
      ) : (
        content
      )}
    </button>
  );
}

/**
 * Кнопка, запускающая задание по объекту.
 *
 * Весь путь показывает собой, не меняя геометрии страницы:
 *
 *   [✂ Нарезать]  ->  [◌ В очереди]  ->  [● Идёт 0:42]  ->  [✂ Нарезать]
 *
 * Между нажатием и появлением задания в опросе есть зазор - на это время
 * кнопка держит локальное «ожидание», иначе она мигала бы: нажали,
 * вернулась в обычный вид, через секунду снова стала занятой.
 */
export function JobButton({
  target,
  kinds,
  onRun,
  icon,
  variant = "default",
  size = "md",
  disabled = false,
  compact = false,
  children,
}: {
  /** Идентификатор объекта задания: эфир или логин канала. */
  target: string;
  /** Какие задания считать «своими» (суффиксы имени очереди). */
  kinds?: string[];
  onRun: () => Promise<unknown>;
  icon?: string;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  /**
   * Квадратная кнопка-иконка: состояние показывается сменой значка
   * (иконка -> спиннер -> пульс), подпись уходит в title. Для мест, где
   * целой кнопке с текстом не место - например, в заголовке таблицы.
   */
  compact?: boolean;
  children: React.ReactNode;
}) {
  const { activeFor, refresh } = useJobs();
  const { viewer } = useSession();
  disabled = disabled || !viewer || !!viewer.isPreview || viewer.role === "moderator";
  const [pending, setPending] = useState(false);
  const job = activeFor(target, kinds);
  const elapsed = useElapsed(job?.startedAt ?? null);

  // Задание появилось в опросе - локальное ожидание больше не нужно.
  useEffect(() => {
    if (job) setPending(false);
  }, [job]);

  // Подстраховка: если задание так и не появилось (отброшено как дубль),
  // кнопка не должна остаться занятой навсегда.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(false), 8000);
    return () => clearTimeout(timer);
  }, [pending]);

  const start = async () => {
    setPending(true);
    try {
      await onRun();
      refresh();
    } catch (error) {
      setPending(false);
      toast.error(String(error));
    }
  };

  const running = pending || Boolean(job);

  if (compact) {
    return (
      <button
        className={
          `btn btn-${variant} btn-${size} btn-compact` +
          (running ? " btn-busy" : "") +
          (job?.startedAt ? " btn-running" : "")
        }
        disabled={disabled || running}
        onClick={start}
        title={
          job?.startedAt
            ? `Идёт ${elapsed}`
            : running
              ? "В очереди"
              : typeof children === "string"
                ? children
                : undefined
        }
      >
        {running ? (
          job?.startedAt ? (
            <span className="dot dot-active" />
          ) : (
            <span className="spinner" />
          )
        ) : (
          <span className="btn-icon">{icon ?? "⟳"}</span>
        )}
      </button>
    );
  }

  /**
   * Ширина кнопки не меняется между состояниями.
   *
   * Все варианты содержимого лежат в одной ячейке сетки: невидимые
   * «призраки» задают ширину под самый длинный, видимый слой просто
   * сменяется поверх. Так «Нарезать» -> «Идёт 12:42» не сдвигает соседей
   * ни на пиксель - меняется только то, что внутри.
   */
  return (
    <button
      className={
        `btn btn-${variant} btn-${size}` +
        (running ? " btn-busy" : "") +
        (job?.startedAt ? " btn-running" : "")
      }
      disabled={disabled || running}
      onClick={start}
    >
      <span className="btn-stack">
        <span className="btn-reserve" aria-hidden>
          {icon && <span className="btn-icon">{icon}</span>}
          <span>{children}</span>
        </span>
        <span className="btn-reserve" aria-hidden>
          <span className="spinner" />
          <span>В очереди</span>
        </span>
        <span className="btn-reserve" aria-hidden>
          <span className="dot" />
          <span>Идёт 888:88</span>
        </span>

        <span className="btn-layer">
          {running ? (
            job?.startedAt ? (
              <span className="dot dot-active" />
            ) : (
              <span className="spinner" />
            )
          ) : icon ? (
            <span className="btn-icon">{icon}</span>
          ) : null}
          <span>
            {job?.startedAt ? `Идёт ${elapsed}` : running ? "В очереди" : children}
          </span>
        </span>
      </span>
    </button>
  );
}

export function Pill({
  children,
  tone = "",
}: {
  children: React.ReactNode;
  tone?: "" | "ok" | "bad" | "warn" | "on";
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

/**
 * Заголовок раздела.
 *
 * action - кнопка при самом заголовке (сразу за текстом), aside -
 * справочная подпись у правого края. Это разные места: действие
 * относится к разделу и живёт рядом с его именем, подпись - фон.
 */
export function SectionTitle({
  children,
  action,
  aside,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="section-title">
      <h2>{children}</h2>
      {action && <div className="section-action">{action}</div>}
      {aside && <div className="section-aside">{aside}</div>}
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`panel ${className}`}>{children}</div>;
}

/**
 * Каркас страницы на время загрузки.
 *
 * Пустой экран, на месте которого разом возникает содержимое, читается
 * как рывок. Мерцающие плашки той же формы делают появление данных
 * заменой, а не вспышкой.
 */
export function PageSkeleton() {
  return (
    <div className="skeleton" aria-hidden>
      <div className="shimmer" style={{ width: "38%", height: 30 }} />
      <div className="shimmer" style={{ width: "58%", height: 15 }} />
      <div className="skeleton-row">
        <div className="shimmer" style={{ flex: 1, height: 84 }} />
        <div className="shimmer" style={{ flex: 1, height: 84 }} />
        <div className="shimmer" style={{ flex: 1, height: 84 }} />
      </div>
      <div className="shimmer" style={{ width: "100%", height: 200 }} />
    </div>
  );
}

/** Подпись вида «0:42» - сколько идёт работа. Без счётчика непонятно,
 *  работает задание или зависло. */
export function useElapsed(since: string | null | undefined): string {
  const [, force] = useState(0);
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [since]);

  if (!since) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
