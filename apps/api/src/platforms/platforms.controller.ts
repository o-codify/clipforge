import { Controller, Delete, Get, Param, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { AdminOnly, Public } from "../auth/auth.guard.js";
import { CONFIG, type ApiConfig } from "../config.js";
import { Inject } from "@nestjs/common";
import { PlatformsService } from "./platforms.service.js";

@Controller("api/platforms")
export class PlatformsController {
  constructor(
    private readonly platforms: PlatformsService,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @AdminOnly()
  @Get()
  accounts() {
    return this.platforms.accounts();
  }

  @AdminOnly()
  @Post("youtube/check")
  check() { return this.platforms.check(); }

  @AdminOnly()
  @Post("youtube/connect")
  connect() {
    return this.platforms.connectUrl();
  }

  /**
   * Возврат со страницы согласия Google. Маршрут открыт: браузер
   * приходит по редиректу, подлинность подтверждает одноразовый state.
   * После обмена админ возвращается в настройки.
   */
  @Public()
  @Get("youtube/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const back = `${this.config.webOrigin}/me`;
    if (error || !code || !state) {
      return reply.redirect(`${back}?youtube=denied`, 302);
    }
    try {
      await this.platforms.handleCallback(code, state);
      return reply.redirect(`${back}?youtube=connected`, 302);
    } catch {
      return reply.redirect(`${back}?youtube=failed`, 302);
    }
  }

  @AdminOnly()
  @Delete(":id")
  disconnect(@Param("id") id: string) {
    return this.platforms.disconnect(id);
  }

  @AdminOnly()
  @Post("publish/:clipId")
  publish(@Param("clipId") clipId: string) {
    return this.platforms.publish(clipId);
  }
}
