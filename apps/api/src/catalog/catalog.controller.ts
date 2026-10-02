import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { AdminOnly, CurrentViewer } from "../auth/auth.guard.js";
import type { Viewer } from "../auth/auth.service.js";
import { CandidatesService } from "./candidates.service.js";
import { CatalogService } from "./catalog.service.js";

@Controller("api")
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly candidates: CandidatesService,
  ) {}

  /** Что система предлагает нарезать - ждёт одной кнопки. */
  @Get("proposals")
  proposals(@CurrentViewer() viewer: Viewer | null) {
    return this.catalog.proposals(viewer);
  }

  @Get("summary")
  summary(@CurrentViewer() viewer: Viewer | null) {
    return this.catalog.summary(viewer);
  }

  @Get("games")
  games(@CurrentViewer() viewer: Viewer | null) {
    return this.catalog.games(viewer);
  }

  @Get("streamers")
  streamers(@CurrentViewer() viewer: Viewer | null, @Query("game") game?: string) {
    return this.catalog.streamers(viewer, game);
  }

  @Get("streamers/:login")
  streamer(@CurrentViewer() viewer: Viewer | null, @Param("login") login: string) {
    return this.catalog.streamer(viewer, login);
  }

  @AdminOnly()
  @Post("streamers/:login/state")
  setState(@Param("login") login: string, @Body() body: unknown) {
    const { state } = z
      .object({ state: z.enum(["candidate", "active", "paused"]) })
      .parse(body);
    return this.catalog.setStreamerState(login, state);
  }

  @AdminOnly()
  @Post("streamers/:login/auto-publish")
  setAutoPublish(@Param("login") login: string, @Body() body: unknown) {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(body);
    return this.catalog.setAutoPublish(login, enabled);
  }

  @Get("vods")
  vods(
    @CurrentViewer() viewer: Viewer | null,
    @Query("streamer") streamer?: string,
    @Query("game") game?: string,
    @Query("state") state?: string,
  ) {
    return this.catalog.vods(viewer, { streamer, game, state });
  }

  @AdminOnly()
  @Post('streamers/:login/youtube-channel')
  setYoutubeChannel(@Param('login') login:string,@Body() body:unknown) {
    const {channelId}=z.object({channelId:z.string().min(1).max(100).nullable()}).strict().parse(body);
    return this.catalog.setYoutubeChannel(login,channelId);
  }

  @AdminOnly()
  @Post("streamers/:login/audio")
  streamerAudio(@Param("login") login: string, @Body() body: unknown) {
    const {audioMode} = z.object({audioMode: z.enum(["original", "dtln", "dtln-gated"])}).strict().parse(body);
    return this.catalog.setStreamerAudio(login, audioMode);
  }

  @AdminOnly()
  @Post("vods/:id/audio")
  vodAudio(@Param("id") id: string, @Body() body: unknown) {
    const {audioMode} = z.object({audioMode: z.enum(["original", "dtln", "dtln-gated"]).nullable()}).strict().parse(body);
    return this.catalog.setVodAudio(id, audioMode);
  }

  @AdminOnly()
  @Post("streamers/:login/ads")
  streamerAds(@Param("login") login:string,@Body() body:unknown) {
    const input=z.object({enabled:z.boolean(),applyToAll:z.boolean().default(false)}).strict().parse(body);
    return this.catalog.setStreamerAds(login,input.enabled,input.applyToAll);
  }

  @AdminOnly()
  @Post("vods/:id/ads")
  vodAds(@Param("id") id:string,@Body() body:unknown) {
    const {enabled}=z.object({enabled:z.boolean().nullable()}).strict().parse(body);
    return this.catalog.setVodAds(id,enabled);
  }

  @Get("vods/:id")
  vod(@CurrentViewer() viewer: Viewer | null, @Param("id") id: string) {
    return this.catalog.vod(viewer, id);
  }

  /** Сколько моментов найдено в эфире и каких - до запуска нарезки. */
  @Get("vods/:id/candidates")
  async vodCandidates(
    @CurrentViewer() viewer: Viewer | null,
    @Param("id") id: string,
  ) {
    // Видимость проверяется каталогом: чужой эфир просто не найдётся.
    await this.catalog.vod(viewer, id);
    return this.candidates.preview(id);
  }

  @Get("runs/:id")
  run(@CurrentViewer() viewer: Viewer | null, @Param("id") id: string) {
    return this.catalog.run(viewer, id);
  }

  @Get("clips")
  clips(
    @CurrentViewer() viewer: Viewer | null,
    @Query("game") game?: string,
    @Query("streamer") streamer?: string,
    @Query("vod") vodId?: string,
    @Query("run") runId?: string,
    @Query("trigger") trigger?: string,
    @Query("state") state?: string,
    @Query("limit") limit?: string,
  ) {
    return this.catalog.clips(
      viewer,
      { game, streamer, vodId, runId, trigger, state },
      Math.min(Number(limit ?? 120), 500),
    );
  }

  @Get("clips/:id")
  clip(@CurrentViewer() viewer: Viewer | null, @Param("id") id: string) {
    return this.catalog.clip(viewer, id);
  }

  /**
   * Снять клип с публикации: жалоба на авторские права или ручной запрет.
   * Доступно и стримеру - это про его собственный контент.
   */
  @Post("clips/:id/block")
  block(
    @CurrentViewer() viewer: Viewer | null,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { reason } = z.object({ reason: z.string().max(500).default("") }).parse(body ?? {});
    return this.catalog.blockClip(viewer, id, reason);
  }

  @Post("clips/:id/state")
  state(
    @CurrentViewer() viewer: Viewer | null,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { state, reviewed } = z.object({ state: z.enum(["draft", "ready"]), reviewed:z.boolean().default(false) }).parse(body);
    return this.catalog.setClipState(viewer, id, state, reviewed);
  }
}
