import { Body, Controller, Delete, Get, Param, Post, Query, Res } from "@nestjs/common";
import { z } from "zod";
import { refreshYoutubePayload, batchPublicationOptions } from '@clipforge/jobs';
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
  @Get('batches')
  batches() { return this.platforms.batches(); }

  @AdminOnly()
  @Post('batches/:id')
  configureBatch(@Param('id') id:string,@Body() body:unknown) {
    return this.platforms.configureBatch(z.string().uuid().parse(id),batchPublicationOptions.parse(body));
  }

  @AdminOnly()
  @Delete('batches/:id')
  pauseBatch(@Param('id') id:string) { return this.platforms.pauseBatch(z.string().uuid().parse(id)); }

  @AdminOnly()
  @Get('publications/:id')
  publication(@Param('id') id:string) {
    return this.platforms.publication(z.string().min(1).max(200).parse(id));
  }

  @AdminOnly()
  @Post('youtube/refresh')
  refresh(@Body() body:unknown) {
    return this.platforms.refresh(refreshYoutubePayload.parse(body??{}));
  }

  @AdminOnly()
  @Post("youtube/check")
  check(@Body() body: unknown) {
    const { accountId } = z.object({ accountId:z.string().min(1).optional() }).parse(body ?? {});
    return this.platforms.check(accountId);
  }

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
    const back = `${this.config.webOrigin}/settings/publication`;
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
  @Get("publish/:clipId")
  preview(@Param("clipId") clipId: string) {
    return this.platforms.preview(clipId);
  }

  @AdminOnly()
  @Post("publish/:clipId")
  publish(@Param("clipId") clipId: string, @Body() body: unknown) {
    const metadata = z.object({
      accountId: z.string().min(1), title: z.string(), description: z.string(),
      privacy: z.enum(["private", "unlisted", "public"]),
    }).strict().parse(body);
    return this.platforms.publish(clipId, metadata);
  }
}
