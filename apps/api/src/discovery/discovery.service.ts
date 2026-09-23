/**
 * Поиск стримеров на Twitch.
 *
 * То, ради чего площадка вообще может работать сама: перебрать каталог,
 * оценить кандидатов и предложить, кого подключить. Без Twitch API это
 * невозможно - у yt-dlp нет экстрактора каталога вовсе.
 *
 * Оценка - формула, а не обученная модель, и это осознанно: обучать
 * нечему, пока нет ни одной публикации со статистикой. Формула на
 * понятных сигналах честнее модели, обученной на пустоте; заменить её
 * можно, не трогая ничего вокруг.
 */
import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { desc, eq, isNull, sql } from "drizzle-orm";

import { discovery, games, streamers, type Database } from "@clipforge/db";
import { clipBudget, scoreCandidate, TwitchClient } from "@clipforge/twitch";

import { CONFIG, DATABASE, TWITCH, type ApiConfig } from "../config.js";

@Injectable()
export class DiscoveryService {
  private readonly log = new Logger("discovery");

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(TWITCH) private readonly twitch: TwitchClient | null,
  ) {}

  get available(): boolean {
    return this.twitch !== null;
  }

  private client(): TwitchClient {
    if (!this.twitch) {
      throw new ServiceUnavailableException(
        "не заданы TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET - поиск стримеров недоступен",
      );
    }
    return this.twitch;
  }

  /** Игры, в которые сейчас играют - для выбора, где искать. */
  async topGames(limit = 40) {
    const list = await this.client().topGames(limit);
    const known = await this.db.select({ slug: games.slug }).from(games);
    const slugs = new Set(known.map((g) => g.slug));
    return list.map((game) => ({
      ...game,
      boxArt: game.boxArt.replace("{width}x{height}", "144x192"),
      known: slugs.has(game.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_")),
    }));
  }

  /**
   * Обойти каталог по игре и языку, оценить и запомнить кандидатов.
   *
   * Уже подключённые каналы отсеиваются: предлагать добавить того, кто
   * уже добавлен, - самый быстрый способ сделать список бесполезным.
   */
  async scan(options: { game: string; language?: string; limit?: number }) {
    const client = this.client();
    const language = options.language ?? this.config.languages[0] ?? "ru";

    const [game] = await client.games([options.game]);
    if (!game) return { found: 0, candidates: [] };

    const live = await client.streams({
      gameId: game.id, language, first: options.limit ?? 20,
    });

    const connected = new Set(
      (await this.db.select({ login: streamers.login }).from(streamers))
        .map((s) => s.login),
    );

    const found: {
      login: string; displayName: string; viewers: number; followers: number;
      archives: number; score: number; reason: string; budget: number; connected: boolean;
    }[] = [];

    for (const stream of live) {
      // Фолловеры и архивы - по запросу на канал, поэтому обход
      // ограничен: сотня каналов это сотня пар запросов.
      const followers = await client.followerCount(stream.userId);
      const archives = await client.archives(stream.userId, 5);
      const archiveViews = archives.length
        ? Math.round(archives.reduce((sum, a) => sum + a.viewCount, 0) / archives.length)
        : 0;

      const signals = {
        viewers: stream.viewerCount, followers, language: stream.language,
        archiveViews, archives: archives.length,
      };
      const { score, reason } = scoreCandidate(signals, {
        languages: this.config.languages,
      });

      found.push({
        login: stream.userLogin, displayName: stream.userName,
        viewers: stream.viewerCount, followers, archives: archives.length,
        score, reason, budget: clipBudget(signals),
        connected: connected.has(stream.userLogin),
      });

      await this.db
        .insert(discovery)
        .values({
          login: stream.userLogin, displayName: stream.userName,
          game: game.name, language: stream.language,
          viewers: stream.viewerCount, followers, score, reason,
          status: connected.has(stream.userLogin) ? "added" : "new",
          checkedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: discovery.login,
          set: {
            displayName: stream.userName, game: game.name,
            viewers: stream.viewerCount, followers, score, reason,
            checkedAt: new Date(),
          },
        });
    }

    found.sort((a, b) => b.score - a.score);
    this.log.log(`каталог ${game.name}/${language}: ${found.length} кандидатов`);
    return { found: found.length, game: game.name, language, candidates: found };
  }

  /** Что нашлось раньше - показывается без обращения к Twitch. */
  async candidates(status: "new" | "added" | "ignored" = "new", limit = 50) {
    return this.db
      .select()
      .from(discovery)
      .where(eq(discovery.status, status))
      .orderBy(desc(discovery.score))
      .limit(limit);
  }

  async ignore(login: string) {
    await this.db
      .update(discovery)
      .set({ status: "ignored" })
      .where(eq(discovery.login, login));
    return { ok: true };
  }

  /**
   * Обновить статус подключённых каналов: кто сейчас в эфире.
   *
   * Одним запросом на сто каналов - поэтому знать это про всю площадку
   * стоит одного обращения, а не одного на канал. Через yt-dlp пришлось
   * бы платить полторы секунды за каждый.
   */
  async refreshLive(): Promise<number> {
    if (!this.twitch) return 0;

    const logins = (
      await this.db.select({ login: streamers.login }).from(streamers)
    ).map((s) => s.login);
    if (logins.length === 0) return 0;

    const live = new Map<string, { game: string; viewers: number }>();
    for (let i = 0; i < logins.length; i += 100) {
      const batch = logins.slice(i, i + 100);
      for (const stream of await this.twitch.streams({ logins: batch })) {
        live.set(stream.userLogin, {
          game: stream.gameName, viewers: stream.viewerCount,
        });
      }
    }

    // Сначала гасим всех, потом поднимаем тех, кто в эфире. Два простых
    // запроса вместо одного хитрого: значения уходят параметрами, а не
    // склейкой строк, и вопрос экранирования не встаёт вовсе.
    await this.db
      .update(streamers)
      .set({ live: false, liveViewers: null, checkedAt: new Date() });

    for (const [login, info] of live) {
      await this.db
        .update(streamers)
        .set({
          live: true, liveGame: info.game,
          liveViewers: info.viewers, lastGame: info.game,
        })
        .where(eq(streamers.login, login));
    }
    return live.size;
  }

  /**
   * Добрать обложки играм, у которых их нет.
   *
   * Обложка тянется при заведении игры, но игры, заведённые до того как
   * появились ключи Twitch, остались с пустым полем - и в меню у них
   * серые квадраты. Это разовая починка, которую можно позвать когда
   * угодно: игры с обложкой она не трогает.
   */
  async refreshGames(): Promise<{ filled: number; total: number }> {
    const client = this.client();
    const missing = await this.db
      .select({ slug: games.slug, title: games.title })
      .from(games)
      .where(isNull(games.boxArt));

    let filled = 0;
    // По сто названий за запрос - Helix принимает столько за раз.
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      const found = await client.games(batch.map((g) => g.title));
      const byName = new Map(found.map((g) => [g.name.toLowerCase(), g]));

      for (const game of batch) {
        const match = byName.get(game.title.toLowerCase());
        if (!match) continue;
        await this.db
          .update(games)
          .set({
            twitchId: match.id,
            boxArt: match.boxArt.replace("{width}x{height}", "144x192"),
          })
          .where(eq(games.slug, game.slug));
        filled += 1;
      }
    }

    this.log.log(`обложки: заполнено ${filled} из ${missing.length}`);
    return { filled, total: missing.length };
  }

  /** Профиль канала с Twitch: имя, аватарка, фолловеры. */
  async refreshProfile(login: string) {
    const client = this.client();
    const [user] = await client.users([login]);
    if (!user) return null;

    const followers = await client.followerCount(user.id);
    await this.db
      .update(streamers)
      .set({
        displayName: user.displayName, twitchId: user.id,
        avatar: user.avatar, description: user.description,
        followers, checkedAt: new Date(),
      })
      .where(eq(streamers.login, login));
    return { login, displayName: user.displayName, followers, avatar: user.avatar };
  }
}
