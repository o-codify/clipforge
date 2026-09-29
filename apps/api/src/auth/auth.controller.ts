import { Body, Controller, Get, Param, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";

import { AdminOnly, CurrentViewer, Public, SESSION_COOKIE } from "./auth.guard.js";
import { AuthService, type Viewer } from "./auth.service.js";

const credentials = z.object({
  login: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

const actAs = z.object({
  /** null - вернуться к своему взгляду администратора. */
  streamer: z.string().min(1).max(64).nullable(),
});

const newAccount = z.object({
  login: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  displayName: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(8).max(200),
  streamer: z.string().min(1).max(64).nullable().default(null),
  role: z.enum(["admin", "moderator", "user"]).default("user"),
});

@Controller("api/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @AdminOnly()
  @Get("accounts")
  accounts() { return this.auth.listAccounts(); }

  @AdminOnly()
  @Post("accounts/:id")
  updateAccount(@Param("id") id: string, @Body() body: unknown) {
    const patch = z.object({ displayName: z.string().trim().min(1).max(100).optional(),
      role: z.enum(["admin", "moderator", "user"]).optional(),
      streamer: z.string().regex(/^[a-z0-9_]+$/).nullable().optional() }).parse(body);
    return this.auth.updateAccount(id, patch);
  }

  @AdminOnly()
  @Post("accounts/:id/password")
  resetPassword(@Param("id") id: string, @Body() body: unknown) {
    const { password } = z.object({ password: z.string().min(8).max(200) }).parse(body);
    return this.auth.changePassword(id, password);
  }

  @Post("profile")
  profile(@CurrentViewer() viewer: Viewer, @Body() body: unknown) {
    const patch = z.object({ displayName: z.string().trim().min(1).max(100) }).parse(body);
    return this.auth.updateAccount(viewer.accountId, patch);
  }

  @Post("password")
  password(@CurrentViewer() viewer: Viewer, @Body() body: unknown) {
    const data = z.object({ current: z.string().min(1).max(200), password: z.string().min(8).max(200) }).parse(body);
    return this.auth.changePassword(viewer.accountId, data.password, data.current);
  }

  @Public()
  @Post("login")
  async login(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { login, password } = credentials.parse(body);
    const { token, viewer } = await this.auth.login(login, password);

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,     // скрипту на странице токен недоступен
      sameSite: "lax",    // не уезжает на чужие сайты
      path: "/",
      maxAge: 30 * 86_400,
      // secure включается за https; на локальной машине его нет, и с
      // secure cookie просто не поставится.
      secure: process.env.NODE_ENV === "production",
    });
    return { viewer };
  }

  @Post("logout")
  async logout(@Res({ passthrough: true }) reply: FastifyReply) {
    const token = reply.request.cookies?.[SESSION_COOKIE];
    if (token) await this.auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }

  /** Кто я. Открытый маршрут: интерфейсу нужно знать, показывать ли вход. */
  @Public()
  @Get("me")
  me(@CurrentViewer() viewer: Viewer | null) {
    return {
      viewer,
      // Регистрация выключена: аккаунты заводит администратор.
      registrationOpen: false,
    };
  }

  @AdminOnly()
  @Post("act-as")
  async act(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { streamer } = actAs.parse(body);
    const token = reply.request.cookies?.[SESSION_COOKIE] ?? "";
    return { viewer: await this.auth.actAs(token, streamer) };
  }

  @AdminOnly()
  @Post("accounts")
  async create(@Body() body: unknown) {
    const account = newAccount.parse(body);
    await this.auth.createStreamerAccount(
      account.login, account.password, account.streamer, account.role, account.displayName,
    );
    return { ok: true };
  }
}
