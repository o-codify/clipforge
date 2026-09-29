/**
 * Аккаунты, сессии и просмотр от лица стримера.
 *
 * Регистрация выключена намеренно: пока площадкой пользуется один
 * администратор, открытая форма регистрации - это только дыра. Аккаунты
 * стримеров заводит админ, когда подключает канал.
 *
 * Первый администратор создаётся при старте, если аккаунтов нет вовсе.
 * Пароль берётся из ADMIN_PASSWORD, а если его нет - генерируется и
 * печатается в журнал ровно один раз. Пароля по умолчанию не существует:
 * «admin/admin» на машине, смотрящей в сеть, живёт до первого сканера.
 */
import { randomBytes } from "node:crypto";

import { BadRequestException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { and, eq, gt, sql } from "drizzle-orm";

import { accounts, sessions, streamers, upgradeRuntime, type Database } from "@clipforge/db";

import { generatePassword, hashPassword, verifyPassword } from "./password.js";

/** Сколько живёт сессия. Месяц - площадка внутренняя, не банк. */
const SESSION_DAYS = 30;

export interface Viewer {
  accountId: string;
  login: string;
  role: "admin" | "moderator" | "user";
  displayName: string;
  /**
   * Чьими глазами смотрим. Для стримера - всегда он сам; для админа -
   * либо null (видит всё), либо логин стримера, если включил просмотр
   * от его лица.
   */
  actingAs: string | null;
  /** Действующие права: в режиме просмотра административный доступ отключён. */
  isAdmin: boolean;
  isPreview: boolean;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger("auth");

  constructor(private readonly db: Database) {}

  /** Создать администратора, если аккаунтов ещё нет. */
  async bootstrap(): Promise<void> {
    await upgradeRuntime(this.db);
    const [existing] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(accounts);
    if ((existing?.count ?? 0) > 0) return;

    const login = process.env.ADMIN_LOGIN?.trim() || "admin";
    if (process.env.NODE_ENV === "production" && !process.env.ADMIN_PASSWORD?.trim()) {
      throw new Error("Для первого запуска production задайте ADMIN_PASSWORD через секреты Coolify");
    }
    const password = process.env.ADMIN_PASSWORD?.trim() || generatePassword();
    const generated = !process.env.ADMIN_PASSWORD?.trim();

    await this.db.insert(accounts).values({
      id: `acc_${randomBytes(8).toString("hex")}`,
      login,
      passwordHash: await hashPassword(password),
      role: "admin",
      displayName: "Администратор",
    });

    if (generated) {
      // Печатается один раз и больше нигде не хранится в открытом виде.
      this.log.warn(
        `создан администратор ${login}, пароль: ${password}\n` +
          "запиши его: восстановить нельзя, только сбросить",
      );
    } else {
      this.log.log(`создан администратор ${login} с паролем из ADMIN_PASSWORD`);
    }
  }

  async login(login: string, password: string): Promise<{ token: string; viewer: Viewer }> {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(sql`lower(${accounts.login}) = lower(${login})`);

    // Пароль проверяется даже когда аккаунта нет: иначе по времени
    // ответа видно, какие логины существуют.
    const hash = account?.passwordHash ?? (await hashPassword("нет такого"));
    const ok = await verifyPassword(password, hash);
    if (!account || !ok) throw new UnauthorizedException("неверный логин или пароль");

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await this.db.insert(sessions).values({
      token, accountId: account.id, expiresAt,
      actingAs: account.role === "user" ? account.streamer : null,
    });
    await this.db
      .update(accounts)
      .set({ lastSeen: new Date() })
      .where(eq(accounts.id, account.id));

    return { token, viewer: this.toViewer(account, account.role === "user" ? account.streamer : null) };
  }

  async logout(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.token, token));
  }

  async listAccounts() {
    return this.db.select({ id: accounts.id, login: accounts.login, role: accounts.role,
      displayName: accounts.displayName, streamer: accounts.streamer, lastSeen: accounts.lastSeen }).from(accounts);
  }

  async updateAccount(id: string, patch: { displayName?: string; role?: "admin" | "moderator" | "user"; streamer?: string | null }) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(740020)`);
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, id));
      if (!account) throw new BadRequestException("Аккаунт не найден");
      if (account.role === "admin" && patch.role && patch.role !== "admin") {
        const admins = await tx.select().from(accounts).where(eq(accounts.role, "admin"));
        if (admins.length <= 1) throw new BadRequestException("Нельзя убрать последнего администратора");
      }
      if (patch.streamer) {
        const [channel] = await tx.select().from(streamers).where(eq(streamers.login, patch.streamer));
        if (!channel) throw new BadRequestException("Канал не найден");
        const [owner] = await tx.select().from(accounts).where(and(eq(accounts.streamer, patch.streamer), sql`${accounts.id} <> ${id}`));
        if (owner) throw new BadRequestException("Канал уже связан с другим аккаунтом");
      }
      await tx.update(accounts).set(patch).where(eq(accounts.id, id));
      if ((patch.role !== undefined && patch.role !== account.role) || (patch.streamer !== undefined && patch.streamer !== account.streamer)) {
        await tx.delete(sessions).where(eq(sessions.accountId, id));
      }
    });
    return { ok: true };
  }

  async changePassword(id: string, password: string, current?: string) {
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, id));
    if (!account) throw new BadRequestException("Аккаунт не найден");
    if (current !== undefined && !(await verifyPassword(current, account.passwordHash))) {
      throw new BadRequestException("Текущий пароль неверен");
    }
    await this.db.update(accounts).set({ passwordHash: await hashPassword(password) }).where(eq(accounts.id, id));
    await this.db.delete(sessions).where(eq(sessions.accountId, id));
    return { ok: true };
  }

  /** Кто пришёл с этим токеном. null - никто. */
  async viewerFor(token: string | undefined): Promise<Viewer | null> {
    if (!token) return null;

    const [row] = await this.db
      .select({ account: accounts, session: sessions })
      .from(sessions)
      .innerJoin(accounts, eq(accounts.id, sessions.accountId))
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())));

    if (!row) return null;
    return this.toViewer(row.account, row.session.actingAs);
  }

  /**
   * Смотреть площадку глазами стримера.
   *
   * Аккаунт остаётся своим - подменяется только видимость. Так админ
   * видит ровно то, что видит стример, но в журнале действий остаётся
   * настоящий автор.
   */
  async actAs(token: string, streamer: string | null): Promise<Viewer> {
    const viewer = await this.viewerFor(token);
    if (!viewer) throw new UnauthorizedException("нет сессии");
    if (!viewer.isAdmin && !viewer.isPreview) throw new UnauthorizedException("только для администратора");

    if (streamer) {
      const [exists] = await this.db
        .select({ login: streamers.login })
        .from(streamers)
        .where(eq(streamers.login, streamer));
      if (!exists) throw new UnauthorizedException(`нет стримера ${streamer}`);
    }

    await this.db
      .update(sessions)
      .set({ actingAs: streamer })
      .where(eq(sessions.token, token));

    return (await this.viewerFor(token))!;
  }

  /** Завести аккаунт стримеру. Доступно только администратору. */
  async createStreamerAccount(
    login: string,
    password: string,
    streamer: string | null,
    role: "admin" | "moderator" | "user" = "user",
    displayName?: string,
  ): Promise<void> {
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(740020)`);
    if (streamer) {
      const [channel] = await tx.select().from(streamers).where(eq(streamers.login, streamer));
      if (!channel) throw new BadRequestException("Канал не найден");
      const [owner] = await tx.select().from(accounts).where(eq(accounts.streamer, streamer));
      if (owner) throw new BadRequestException("Канал уже связан с другим аккаунтом");
    }
    const [duplicate] = await tx.select().from(accounts).where(sql`lower(${accounts.login}) = lower(${login})`);
    if (duplicate) throw new BadRequestException("Логин уже занят");
    await tx.insert(accounts).values({
      id: `acc_${randomBytes(8).toString("hex")}`,
      login,
      passwordHash,
      role,
      streamer: role === "user" ? streamer : null,
      displayName: displayName ?? login,
    });
    });
  }

  /** Убрать просроченные сессии - иначе таблица растёт вечно. */
  async cleanupSessions(): Promise<number> {
    const removed = await this.db
      .delete(sessions)
      .where(sql`${sessions.expiresAt} < now()`)
      .returning({ token: sessions.token });
    return removed.length;
  }

  private toViewer(
    account: typeof accounts.$inferSelect,
    actingAs: string | null,
  ): Viewer {
    return {
      accountId: account.id,
      login: account.login,
      role: account.role === "admin" && actingAs ? "user" : account.role === "streamer" ? "user" : account.role,
      displayName: account.displayName ?? account.login,
      // Стример не может смотреть ничей канал, кроме своего, что бы ни
      // лежало в сессии.
      actingAs: account.role === "admin" ? actingAs : account.role === "moderator" ? null : (account.streamer ?? "__unlinked_account__"),
      isAdmin: account.role === "admin" && !actingAs,
      isPreview: account.role === "admin" && !!actingAs,
    };
  }
}
