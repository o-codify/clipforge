import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { QUEUES } from "@clipforge/jobs";
import { z } from "zod";

import { AdminOnly, CurrentViewer } from "../auth/auth.guard.js";
import type { Viewer } from "../auth/auth.service.js";
import { CatalogService } from "../catalog/catalog.service.js";
import { JobsService } from "./jobs.service.js";

@Controller("api/jobs")
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly catalog: CatalogService,
  ) {}

  @Get()
  list(@CurrentViewer() viewer: Viewer, @Query("limit") limit?: string) {
    return this.jobs.recent(viewer, z.coerce.number().int().min(1).max(200).parse(limit ?? 30));
  }

  @Get("active")
  active(@CurrentViewer() viewer: Viewer) {
    return this.jobs.active(viewer);
  }

  @Get("conversation")
  conversation(@CurrentViewer() viewer: Viewer) {
    return this.jobs.conversation(viewer);
  }

  @Get(":id/events")
  events(@CurrentViewer() viewer: Viewer, @Param("id") id: string) {
    return this.jobs.events(viewer, z.string().uuid().parse(id));
  }

  @AdminOnly()
  @Post("cancel/:id")
  cancel(@Param("id") id: string) {
    return this.jobs.cancel(id);
  }

  /** Обойти архивы канала. Заводит стримера, если его ещё нет. */
  @AdminOnly()
  @Post("index-channel")
  index(@Body() body: unknown) {
    const payload = z
      .object({
        login: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
        withChapters: z.boolean().default(true),
      })
      .parse(body);
    return this.jobs.enqueue(QUEUES.indexChannel, payload);
  }

  /**
   * Прогнать эфир целиком.
   *
   * Стример может запускать нарезку по своему каналу - это его контент.
   * Проверку видимости делает каталог: чужой эфир он просто не найдёт.
   */
  @Post("pipeline/:vodId")
  async pipeline(
    @CurrentViewer() viewer: Viewer | null,
    @Param("vodId") vodId: string,
    @Body() body: unknown,
  ) {
    await this.catalog.vod(viewer, vodId);
    const { count, force } = z
      .object({
        count: z.number().int().min(1).max(200).optional(),
        force: z.boolean().default(false),
      })
      .parse(body ?? {});
    return this.jobs.enqueue(QUEUES.pipeline, {
      vodId, reuse: !force, ...(count ? { count } : {}),
    });
  }

  @Post("fetch/:vodId")
  async fetch(@CurrentViewer() viewer: Viewer | null, @Param("vodId") vodId: string) {
    await this.catalog.vod(viewer, vodId);
    return this.jobs.enqueue(QUEUES.fetchVod, { vodId, audioOnly: false });
  }

  @Post("render/:vodId")
  async render(
    @CurrentViewer() viewer: Viewer | null,
    @Param("vodId") vodId: string,
    @Body() body: unknown,
  ) {
    await this.catalog.vod(viewer, vodId);
    const { count } = z
      .object({ count: z.number().int().min(1).max(200).optional() })
      .parse(body ?? {});
    return this.jobs.enqueue(QUEUES.renderRun, { vodId, ...(count ? { count } : {}) });
  }
}
