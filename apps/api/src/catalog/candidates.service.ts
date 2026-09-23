/**
 * Предпросмотр моментов эфира.
 *
 * Отвечает на вопрос, который возникает раньше всех остальных: сколько
 * клипов вообще получится и каких. Раньше интерфейс просил ввести число
 * («12») - оно ничего не значило и противоречило замыслу: площадка
 * должна резать столько, сколько нашла триггеров, а не сколько кто-то
 * угадал.
 *
 * Считается быстро: сигналы и расшифровка уже лежат, остаётся арифметика
 * по массивам - около сотой доли секунды на часовой эфир.
 */
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { transcripts, vods, type Database } from "@clipforge/db";
import { SIGNAL_SERIES } from "@clipforge/contracts";
import { detect, labelTrigger, readSignals } from "@clipforge/pipeline";

import { DATABASE } from "../config.js";

export interface CandidatesPreview {
  /** Готов ли эфир к нарезке и чего не хватает. */
  ready: boolean;
  missing: string[];
  total: number;
  /** Сколько моментов каждого типа. */
  byTrigger: { trigger: string; count: number }[];
  /** Плотность: сколько моментов на час эфира. */
  perHour: number;
  /** Суммарная длительность будущих клипов, секунды. */
  seconds: number;
}

@Injectable()
export class CandidatesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async preview(vodId: string): Promise<CandidatesPreview> {
    const [vod] = await this.db.select().from(vods).where(eq(vods.id, vodId));
    if (!vod) throw new NotFoundException(`нет эфира ${vodId}`);

    const [transcript] = await this.db
      .select()
      .from(transcripts)
      .where(eq(transcripts.vodId, vodId));

    const missing: string[] = [];
    if (vod.state !== "ready") missing.push("исходники");
    if (!transcript) missing.push("расшифровка");
    if (!vod.signals) missing.push("сигналы звука");

    if (missing.length > 0 || !vod.signals || !transcript) {
      return { ready: false, missing, total: 0, byTrigger: [], perHour: 0, seconds: 0 };
    }

    const audio = await readSignals(vod.signals.file, {
      frames: vod.signals.frames,
      hopSeconds: vod.signals.hopSeconds,
      duration: vod.signals.duration,
      series: SIGNAL_SERIES,
    });

    const candidates = detect(
      audio,
      {
        language: transcript.language,
        duration: transcript.duration,
        segments: transcript.segments,
      },
      {
        maxCount: 500, minGapSeconds: 22,
        lead: 12, tail: 6, minLen: 25, maxLen: 55,
        minLead: 5, minTail: 4, padBefore: 1.0, padAfter: 1.3,
      },
    );

    const counts = new Map<string, number>();
    let seconds = 0;
    for (const candidate of candidates) {
      const kind = labelTrigger(candidate);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      seconds += candidate.end - candidate.start;
    }

    return {
      ready: true,
      missing: [],
      total: candidates.length,
      byTrigger: [...counts]
        .map(([trigger, count]) => ({ trigger, count }))
        .sort((a, b) => b.count - a.count),
      perHour: Math.round((candidates.length / Math.max(audio.duration, 1)) * 3600),
      seconds: Math.round(seconds),
    };
  }
}
