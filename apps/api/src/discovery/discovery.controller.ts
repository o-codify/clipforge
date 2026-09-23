import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { AdminOnly } from "../auth/auth.guard.js";
import { DiscoveryService } from "./discovery.service.js";

/**
 * Поиск стримеров - дело администратора: он решает, кого подключать.
 * Стримеру этот раздел не показывается вовсе.
 */
@AdminOnly()
@Controller("api/discovery")
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get("status")
  status() {
    return {
      available: this.discovery.available,
      note: this.discovery.available
        ? "поиск доступен"
        : "нужны TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET в .env",
    };
  }

  @Get("games")
  games(@Query("limit") limit?: string) {
    return this.discovery.topGames(Math.min(Number(limit ?? 40), 100));
  }

  @Get("candidates")
  candidates(@Query("status") status?: string, @Query("limit") limit?: string) {
    const parsed = z.enum(["new", "added", "ignored"]).catch("new").parse(status);
    return this.discovery.candidates(parsed, Math.min(Number(limit ?? 50), 200));
  }

  @Post("scan")
  scan(@Body() body: unknown) {
    const payload = z
      .object({
        game: z.string().min(1),
        language: z.string().min(2).max(5).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .parse(body);
    return this.discovery.scan(payload);
  }

  @Post("ignore/:login")
  ignore(@Param("login") login: string) {
    return this.discovery.ignore(login);
  }

  @Post("refresh-games")
  refreshGames() {
    return this.discovery.refreshGames();
  }

  @Post("refresh-live")
  refreshLive() {
    return this.discovery.refreshLive().then((live) => ({ live }));
  }

  @Post("refresh/:login")
  refresh(@Param("login") login: string) {
    return this.discovery.refreshProfile(login);
  }
}
