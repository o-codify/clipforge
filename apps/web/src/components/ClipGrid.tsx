"use client";
import { useSession } from "@/lib/session";

/**
 * Плитка клипов с проигрывателем.
 *
 * Кадр-превью грузится с бэкенда: он режет его ffmpeg-ом и держит в
 * кэше. Клип открывается в окне поверх страницы, а не отдельной
 * страницей - смотреть их приходится подряд, и возвращаться назад после
 * каждого утомительно.
 */
import { useEffect, useState } from "react";

import { Button, Pill } from "@/components/ui";
import { api, hhmm, PUB_STATE, TRIGGERS, type ClipRow } from "@/lib/api";
import { toast } from "@/lib/toast";
import { PublishForm } from "./PublishForm";
import { StreamerBadge } from "./StreamerBadge";
import { ClipCleanup, type MediaSafety } from './ClipCleanup';
import { displayTranscript } from "@clipforge/contracts/text";

interface ClipDetail extends ClipRow {
  safety?:MediaSafety|null;
  publications: {
    id: string; platform: string; privacy?: string | null; error?: string | null; account: string;
    url: string | null; status: string;
  }[];
  versions: {
    id: string; version: string; file: string;
    runId: string; createdAt: string; state: string;
  }[];
}

export function ClipGrid({ clips, onChange }: { clips: ClipRow[]; onChange?: () => void }) {
  const { viewer } = useSession();
  const [open, setOpen] = useState<ClipDetail | null>(null);
  const [busy, setBusy] = useState(false);
  /** Снятие - в два шага прямо в окне: причина спрашивается на месте,
   *  а не системным диалогом, выпадающим из оформления. */
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  const [publishing,setPublishing] = useState(false);

  const pendingPublication = open?.publications.some(p => ['queued', 'uploading', 'processing'].includes(p.status));
  useEffect(() => {
    if (!open?.id || !pendingPublication) return;
    const id = open.id;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const latest = await api.get<ClipDetail>(`/api/clips/${id}`);
        if (active) setOpen(current => current?.id === id ? {...current, publications: latest.publications} : current);
      } catch {
        // Preserve the last confirmed state during a short network outage.
      } finally {
        if (active) timer = setTimeout(refresh, 3000);
      }
    };
    timer = setTimeout(refresh, 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [open?.id, pendingPublication]);

  const show = async (id: string) => {
    setBlocking(false);
    setPublishing(false);
    setReason("");
    setOpen(await api.get<ClipDetail>(`/api/clips/${id}`));
  };

  const block = async (id: string) => {
    setBusy(true);
    try {
      await api.post(`/api/clips/${id}/block`, { reason });
      await show(id);
      onChange?.();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (id: string) => {
    setBusy(true);
    try {
      await api.post(`/api/clips/${id}/state`, { state: "draft" });
      await show(id);
      onChange?.();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  if (clips.length === 0) {
    return <div className="empty">Клипов пока нет.</div>;
  }

  return (
    <>
      <div className="grid clips">
        {clips.map((clip) => (
          <button key={clip.id} className="clip" onClick={() => show(clip.id)}>
            <div
              className="shot"
              style={{ backgroundImage: `url(/media/poster/${clip.id})` }}
            >
              {clip.state === "blocked" && <span className="flag">Снят</span>}
              <span className="len">{hhmm(clip.duration)}</span>
            </div>
            <div className="body">
              <StreamerBadge login={clip.streamer} linked={false}/>
              <div className="name">
                {TRIGGERS[clip.trigger ?? ""] ?? clip.trigger} · {hhmm(clip.start)}
              </div>
              <div className="txt">{clip.text ? displayTranscript(clip.text) : "—"}</div>
            </div>
          </button>
        ))}
      </div>

      {open && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="sheet">
            {/* Закрытие живёт в углу окна, как везде, а не среди кнопок
                управления клипом: это действие над окном, не над клипом. */}
            <button
              className="modal-close"
              aria-label="Закрыть"
              onClick={() => setOpen(null)}
            >
              ✕
            </button>
            <div className="clip-detail-heading"><StreamerBadge login={open.streamer}/><h2>{TRIGGERS[open.trigger ?? ""] ?? "Момент эфира"}</h2></div>
            <div className="player">
              <video src={`/media/clip/${open.id}`} controls autoPlay
                     poster={`/media/poster/${open.id}`} />
              <div className="side">
                <p className="sub">
                  {TRIGGERS[open.trigger ?? ""] ?? open.trigger} ·{" "}
                  {hhmm(open.start)}–{hhmm(open.end)} ({open.duration.toFixed(1)} с)
                </p>
                <p style={{ marginTop: 12 }}>{open.text ? displayTranscript(open.text) : ""}</p>
                {viewer?.isAdmin && <ClipCleanup key={open.id} id={open.id} state={open.state} safety={open.safety}
                  onReady={id=>{void show(id);onChange?.();}} onReview={()=>{void show(open.id);onChange?.();}}/>}

                <h2>Публикации</h2>
                {open.publications.length === 0 ? (
                  <p className="sub">Не публиковался.</p>
                ) : (
                  <div className="scroller">
                    <table>
                      <tbody>
                        {open.publications.map((p) => {
                          const [label, tone] = PUB_STATE[p.status] ?? [p.status, ""];
                          return (
                            <tr key={p.id}>
                              <td>{{ youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", twitch: "Twitch" }[p.platform] ?? p.platform}</td>
                              <td><Pill tone={tone}>{label}</Pill>{p.privacy && <span> · {p.privacy === "public" ? "Публично" : p.privacy === "private" ? "Приватно" : "По ссылке"}</span>}{viewer?.isAdmin && p.error && <p role="alert">{p.error}</p>}</td>
                              <td>
                                {p.url ? (
                                  <a href={p.url} target="_blank" rel="noopener">
                                    Открыть
                                  </a>
                                ) : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {viewer?.isAdmin && open.state === "ready" && (open.safety?.autoVerifiedAt || open.safety?.reviewedAt || open.safety?.disabledAt) &&
                  !open.publications.some(
                    (p) => p.platform === "youtube" && p.status !== "failed",
                  ) && (
                    <div style={{ marginTop: 8 }}>
                      {publishing ? <PublishForm key={open.id} clipId={open.id} onCancel={()=>setPublishing(false)} onDone={()=>{void show(open.id);onChange?.();toast.info("Публикация поставлена в очередь");}}/> : <Button size="sm" variant="primary"
                              onClick={() => setPublishing(true)}>
                        {open.publications.some((p) => p.platform === "youtube")
                          ? "Повторить на YouTube"
                          : "Опубликовать на YouTube"}
                      </Button>}
                    </div>
                  )}

                {viewer.role !== "moderator" && !viewer.isPreview && <div className="actions">
                  {open.state === "blocked" ? (
                    <>
                      <Pill tone="bad">
                        Запрещён: {open.blockedReason || "Без причины"}
                      </Pill>
                      <Button busy={busy} onClick={() => restore(open.id)}>
                        Вернуть
                      </Button>
                    </>
                  ) : blocking ? (
                    <>
                      <input
                        className="field"
                        autoFocus
                        placeholder="Причина (например, жалоба на авторские права)"
                        value={reason}
                        style={{ flex: 1, minWidth: 220 }}
                        onChange={(event) => setReason(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void block(open.id);
                        }}
                      />
                      <Button variant="danger" busy={busy} onClick={() => block(open.id)}>
                        Запретить
                      </Button>
                      <Button variant="ghost" onClick={() => setBlocking(false)}>
                        Отмена
                      </Button>
                    </>
                  ) : (
                    // Одобрения нет: клип одобрен с рождения, площадка
                    // автоматическая. Единственное ручное действие -
                    // снять, если прилетела жалоба.
                    <Button variant="danger" onClick={() => setBlocking(true)}>
                      Запретить новые публикации
                    </Button>
                  )}
                </div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
