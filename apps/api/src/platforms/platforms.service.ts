/**
 * Площадки публикации: подключение аккаунтов и постановка публикаций.
 *
 * Подключение - классический OAuth: генерируется одноразовый state,
 * админ уходит на страницу согласия Google, возвращается на callback,
 * код меняется на refresh token, тот сохраняется. Дальше воркер сам
 * обновляет access token перед каждой загрузкой.
 */
import { randomUUID } from "node:crypto";

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { clips, platformAccounts, publications, runtimeValue, type Database } from "@clipforge/db";
import { QUEUES } from "@clipforge/jobs";
import {
  authUrl,
  exchangeCode,
  myChannel,
  refreshAccessToken,
  type YoutubeApp,
} from "@clipforge/youtube";

import { CONFIG, DATABASE, type ApiConfig } from "../config.js";
import { JobsService } from "../jobs/jobs.service.js";

/** Статусы, в которых публикацию не надо ставить второй раз. */
const IN_FLIGHT = new Set(["queued", "uploading", "uploaded", "processing", "published"]);

@Injectable()
export class PlatformsService {
  /** Одноразовые state для OAuth: значение -> срок годности. */
  private readonly states = new Map<string, number>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ApiConfig,
    private readonly jobs: JobsService,
  ) {}

  private get youtube(): YoutubeApp {
    if (!this.config.youtube) {
      throw new BadRequestException(
        "не заданы YOUTUBE_CLIENT_ID и YOUTUBE_CLIENT_SECRET в .env",
      );
    }
    return this.config.youtube;
  }

  private get redirectUri(): string {
    return `${this.config.apiOrigin}/api/platforms/youtube/callback`;
  }

  /** Подключённые аккаунты. Секреты наружу не отдаются никогда. */
  async accounts() {
    return this.db
      .select({
        id: platformAccounts.id,
        platform: platformAccounts.platform,
        label: platformAccounts.label,
        externalId: platformAccounts.externalId,
        createdAt: platformAccounts.createdAt,
      })
      .from(platformAccounts);
  }

  async check() {
    const [account] = await this.db.select().from(platformAccounts).where(eq(platformAccounts.platform,"youtube"));
    if (!account?.credentials.refreshToken) return { state:"missing", reason:"Подключите YouTube-канал" };
    try {
      const token = await refreshAccessToken(this.youtube,account.credentials.refreshToken);
      const channel = await myChannel(token);
      if (channel?.id !== account.externalId) throw new Error("Подключение принадлежит другому каналу");
      const result = { state:"ok", channel:channel.title };
      await runtimeValue(this.db,"youtube-access",result);
      return result;
    } catch {
      const result = { state:"error", reason:"Доступ недействителен. Подключите YouTube повторно. Для приложения Google в режиме Testing токены могут истекать." };
      await runtimeValue(this.db,"youtube-access",result);
      return result;
    }
  }

  /** Адрес страницы согласия Google для подключения YouTube-канала. */
  connectUrl(): { url: string } {
    const state = randomUUID();
    this.states.set(state, Date.now() + 10 * 60 * 1000);
    // Просроченные state копятся только при брошенных подключениях -
    // чистка попутная, отдельного таймера не нужно.
    for (const [key, expires] of this.states) {
      if (expires < Date.now()) this.states.delete(key);
    }
    return { url: authUrl(this.youtube, this.redirectUri, state) };
  }

  /**
   * Возврат с согласия. Callback открыт (браузер приходит с адреса
   * Google), подлинность подтверждает одноразовый state.
   */
  async handleCallback(code: string, state: string): Promise<void> {
    const expires = this.states.get(state);
    this.states.delete(state);
    if (!expires || expires < Date.now()) {
      throw new BadRequestException("подключение устарело, начните заново");
    }

    const { accessToken, refreshToken } = await exchangeCode(
      this.youtube,
      this.redirectUri,
      code,
    );
    const channel = await myChannel(accessToken);
    if (!channel) throw new BadRequestException("у аккаунта Google нет YouTube-канала");

    await this.db
      .insert(platformAccounts)
      .values({
        id: randomUUID(),
        platform: "youtube",
        label: channel.title,
        externalId: channel.id,
        credentials: { refreshToken },
      })
      .onConflictDoUpdate({
        target: [platformAccounts.platform, platformAccounts.externalId],
        set: { label: channel.title, credentials: { refreshToken } },
      });
  }

  async disconnect(id: string): Promise<void> {
    await this.db.delete(platformAccounts).where(eq(platformAccounts.id, id));
  }

  /**
   * Поставить клип на публикацию.
   *
   * Ряд publications создаётся здесь, воркер только выполняет. Повторная
   * постановка идущей или вышедшей публикации не создаёт дубля - у пары
   * (клип, площадка, аккаунт) одно место.
   */
  async publish(clipId: string): Promise<{ publicationId: string }> {
    const [clip] = await this.db
      .select({ id: clips.id, state: clips.state, archivedAt: clips.archivedAt })
      .from(clips)
      .where(eq(clips.id, clipId));
    if (!clip) throw new NotFoundException("клип не найден");
    if (clip.state !== "ready" || clip.archivedAt) {
      throw new BadRequestException("клип снят с публикации");
    }

    const access = await this.check();
    if (access.state !== "ok") throw new BadRequestException("Подключите YouTube повторно в настройках");

    const [account] = await this.db
      .select()
      .from(platformAccounts)
      .where(eq(platformAccounts.platform, "youtube"));
    if (!account) {
      throw new BadRequestException("YouTube не подключён: сначала подключите канал в настройках");
    }

    const [existing] = await this.db
      .select({ id: publications.id, status: publications.status, error: publications.error })
      .from(publications)
      .where(
        and(
          eq(publications.clipId, clipId),
          eq(publications.platform, "youtube"),
          eq(publications.account, account.externalId),
        ),
      );

    let publicationId: string;
    if (existing?.error?.startsWith("[upload-uncertain]")) {
      throw new BadRequestException("Исход предыдущей загрузки неизвестен. Проверьте канал: повторная отправка может создать дубль.");
    }
    if (existing && IN_FLIGHT.has(existing.status)) {
      // Уже в работе или вышла - просто вернуть, кнопка не дублирует.
      return { publicationId: existing.id };
    } else if (existing) {
      publicationId = existing.id;
      await this.db
        .update(publications)
        .set({ status: "queued", error: null })
        .where(eq(publications.id, existing.id));
    } else {
      publicationId = randomUUID();
      await this.db.insert(publications).values({
        id: publicationId,
        clipId,
        platform: "youtube",
        account: account.externalId,
        status: "queued",
      });
    }

    try {
      await this.jobs.enqueue(QUEUES.publishClip, { publicationId });
    } catch(error) {
      await this.db.update(publications).set({status:"failed",error:"Не удалось поставить в очередь"}).where(eq(publications.id,publicationId));
      throw error;
    }
    return { publicationId };
  }
}
