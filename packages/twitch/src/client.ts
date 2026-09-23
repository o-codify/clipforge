/**
 * Клиент Twitch Helix.
 *
 * Нужен для того, чего yt-dlp не умеет в принципе: перебрать каталог -
 * кто прямо сейчас стримит нужную игру на нужном языке. У yt-dlp нет
 * экстрактора каталога вовсе, запрос к twitch.tv/directory отвечает
 * «directory does not exist».
 *
 * Разделение обязанностей после проверки на живом API:
 *
 *   Helix   - поиск стримеров, статус эфира, зрители, фолловеры,
 *             аватарки, обложки игр, список архивов с просмотрами;
 *   yt-dlp  - главы эфира (во что играли и когда) и сама загрузка.
 *             Глав в Helix нет ни в каком виде, а без них неизвестна
 *             игра каждого клипа на многоигровом стриме.
 *
 * Авторизация - client credentials: серверный токен в обмен на пару
 * id + секрет. Пользователь в этом потоке не участвует, redirect_uri не
 * используется, поэтому площадке не нужен публичный адрес.
 */

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_URL = "https://api.twitch.tv/helix";

export interface TwitchCredentials {
  clientId: string;
  clientSecret: string;
}

export class TwitchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "TwitchError";
  }
}

/** Ключей нет - площадка работает, но поиск стримеров недоступен. */
export class TwitchNotConfigured extends Error {
  constructor() {
    super(
      "не заданы TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET: " +
        "поиск стримеров и статус эфира недоступны",
    );
    this.name = "TwitchNotConfigured";
  }
}

export interface TwitchStream {
  userId: string;
  userLogin: string;
  userName: string;
  gameId: string;
  gameName: string;
  title: string;
  viewerCount: number;
  language: string;
  startedAt: string;
  thumbnail: string;
}

export interface TwitchUser {
  id: string;
  login: string;
  displayName: string;
  description: string;
  avatar: string;
  createdAt: string;
}

export interface TwitchGame {
  id: string;
  name: string;
  boxArt: string;
}

export interface TwitchVideo {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  publishedAt: string;
  /** Строка вида 6h49m1s - Helix не отдаёт секунды числом. */
  duration: string;
  durationSeconds: number;
  viewCount: number;
  url: string;
}

/** «6h49m1s» -> 24541 */
export function parseDuration(value: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value.trim());
  if (!match) return 0;
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

export class TwitchClient {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(private readonly credentials: TwitchCredentials) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): TwitchClient | null {
    const clientId = env.TWITCH_CLIENT_ID?.trim();
    const clientSecret = env.TWITCH_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;
    return new TwitchClient({ clientId, clientSecret });
  }

  /**
   * Серверный токен. Живёт около двух месяцев, поэтому запрашивается
   * лениво и хранится в памяти - складывать его в базу незачем, а
   * перезапуск процесса дешевле, чем ещё одно место, где лежит секрет.
   */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;

    const response = await fetch(TOKEN_URL, {
      signal: AbortSignal.timeout(20_000),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        grant_type: "client_credentials",
      }),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) {
      throw new TwitchError("не удалось получить токен Twitch", response.status, body);
    }

    this.token = body.access_token;
    // Минута запаса: между проверкой и запросом токен не должен успеть
    // протухнуть.
    this.expiresAt = Date.now() + ((body.expires_in ?? 3600) - 60) * 1000;
    return this.token;
  }

  private async get<T>(path: string, params: URLSearchParams): Promise<T[]> {
    const token = await this.accessToken();
    const response = await fetch(`${API_URL}/${path}?${params}`, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        "client-id": this.credentials.clientId,
        authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 401) {
      // Токен отозвали - выбрасываем и пробуем один раз заново.
      this.token = null;
      const retryToken = await this.accessToken();
      const retry = await fetch(`${API_URL}/${path}?${params}`, {
      signal: AbortSignal.timeout(20_000),
        headers: {
          "client-id": this.credentials.clientId,
          authorization: `Bearer ${retryToken}`,
        },
      });
      if (!retry.ok) {
        throw new TwitchError(`Twitch ${path}`, retry.status, await retry.json());
      }
      return ((await retry.json()) as { data: T[] }).data;
    }

    if (!response.ok) {
      throw new TwitchError(`Twitch ${path}`, response.status, await response.json());
    }
    return ((await response.json()) as { data: T[] }).data;
  }

  /** Кто сейчас в эфире по игре и языку - основа поиска стримеров. */
  async streams(options: {
    gameId?: string;
    language?: string;
    logins?: string[];
    first?: number;
  }): Promise<TwitchStream[]> {
    const params = new URLSearchParams();
    if (options.gameId) params.set("game_id", options.gameId);
    if (options.language) params.set("language", options.language);
    // До ста каналов одним запросом - поэтому статус всей площадки
    // стоит одного обращения, а не одного на канал.
    for (const login of options.logins ?? []) params.append("user_login", login);
    params.set("first", String(Math.min(options.first ?? 20, 100)));

    const raw = await this.get<Record<string, unknown>>("streams", params);
    return raw.map((s) => ({
      userId: String(s.user_id),
      userLogin: String(s.user_login),
      userName: String(s.user_name),
      gameId: String(s.game_id ?? ""),
      gameName: String(s.game_name ?? ""),
      title: String(s.title ?? ""),
      viewerCount: Number(s.viewer_count ?? 0),
      language: String(s.language ?? ""),
      startedAt: String(s.started_at ?? ""),
      thumbnail: String(s.thumbnail_url ?? ""),
    }));
  }

  async users(logins: string[]): Promise<TwitchUser[]> {
    if (logins.length === 0) return [];
    const params = new URLSearchParams();
    for (const login of logins.slice(0, 100)) params.append("login", login);

    const raw = await this.get<Record<string, unknown>>("users", params);
    return raw.map((u) => ({
      id: String(u.id),
      login: String(u.login),
      displayName: String(u.display_name ?? u.login),
      description: String(u.description ?? ""),
      avatar: String(u.profile_image_url ?? ""),
      createdAt: String(u.created_at ?? ""),
    }));
  }

  async games(names: string[]): Promise<TwitchGame[]> {
    if (names.length === 0) return [];
    const params = new URLSearchParams();
    for (const name of names.slice(0, 100)) params.append("name", name);

    const raw = await this.get<Record<string, unknown>>("games", params);
    return raw.map((g) => ({
      id: String(g.id),
      name: String(g.name),
      boxArt: String(g.box_art_url ?? ""),
    }));
  }

  async topGames(first = 40): Promise<TwitchGame[]> {
    const raw = await this.get<Record<string, unknown>>(
      "games/top",
      new URLSearchParams({ first: String(Math.min(first, 100)) }),
    );
    return raw.map((g) => ({
      id: String(g.id),
      name: String(g.name),
      boxArt: String(g.box_art_url ?? ""),
    }));
  }

  /**
   * Сколько у канала фолловеров.
   *
   * Список подписчиков закрыт и требует токена самого стримера, а вот
   * общее число приходит и с серверным токеном - в поле total. Это
   * главный сигнал «его много смотрят» при отборе кандидатов.
   */
  async followerCount(broadcasterId: string): Promise<number> {
    const token = await this.accessToken();
    const response = await fetch(
      `${API_URL}/channels/followers?broadcaster_id=${broadcasterId}`,
      {
        headers: {
          "client-id": this.credentials.clientId,
          authorization: `Bearer ${token}`,
        },
      },
    );
    if (!response.ok) return 0;
    const body = (await response.json()) as { total?: number };
    return Number(body.total ?? 0);
  }

  /**
   * Архивы канала. Быстрее и богаче, чем через yt-dlp: приходит число
   * просмотров каждого эфира, а запускать отдельный процесс не нужно.
   *
   * Чего здесь нет - глав. Во что играли и когда, Helix не отдаёт, и за
   * этим по-прежнему идём в yt-dlp.
   */
  async archives(userId: string, first = 20): Promise<TwitchVideo[]> {
    const raw = await this.get<Record<string, unknown>>(
      "videos",
      new URLSearchParams({
        user_id: userId,
        type: "archive",
        first: String(Math.min(first, 100)),
      }),
    );
    return raw.map((v) => ({
      id: String(v.id),
      userId: String(v.user_id),
      title: String(v.title ?? ""),
      createdAt: String(v.created_at ?? ""),
      publishedAt: String(v.published_at ?? v.created_at ?? ""),
      duration: String(v.duration ?? ""),
      durationSeconds: parseDuration(String(v.duration ?? "")),
      viewCount: Number(v.view_count ?? 0),
      url: String(v.url ?? ""),
    }));
  }
}
