import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query } from "@nestjs/common";
import { QUEUES, cleanClipPayload, renderRunPayload, preparePreviewPayload, prepareStreamerPayload } from "@clipforge/jobs";
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

  @AdminOnly()
  @Post('clean-clip/:clipId')
  async cleanClip(@CurrentViewer() viewer:Viewer, @Param('clipId') id:string, @Body() body:unknown) {
    const clip = await this.catalog.clip(viewer,id);
    const input = cleanClipPayload.omit({clipId:true,vodId:true}).parse(body ?? {});
    return this.jobs.enqueue(QUEUES.cleanClip, {...input, clipId:id, vodId:clip.vodId});
  }

  @Get("groups")
  groups(@CurrentViewer() viewer: Viewer) {
    return this.jobs.groups(viewer);
  }

  @AdminOnly()
  @Post('inspect-ads/:vodId')
  async inspectAds(@CurrentViewer() viewer:Viewer,@Param('vodId') vodId:string) {
    await this.catalog.vod(viewer,vodId);
    return this.jobs.enqueue(QUEUES.inspectAds,{vodId});
  }

  @Get("group-runs")
  groupRuns(@CurrentViewer() viewer: Viewer, @Query() query: unknown) {
    const input = z.object({name:z.string().min(1).max(100),streamer:z.string().max(64).default(""),offset:z.coerce.number().int().min(0).default(0)}).parse(query);
    return this.jobs.groupRuns(viewer, input);
  }

  @Get("conversation")
  conversation(@CurrentViewer() viewer: Viewer) {
    return this.jobs.conversation(viewer);
  }

  @Get(":id/events")
  events(@CurrentViewer() viewer: Viewer, @Param("id") id: string) {
    return this.jobs.events(viewer, z.string().uuid().parse(id));
  }

  @Get(':id/status')
  status(@CurrentViewer() viewer:Viewer, @Param('id') id:string) {
    return this.jobs.status(viewer,z.string().uuid().parse(id));
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

  @AdminOnly()
  @Post('prepare/:vodId')
  async prepare(@CurrentViewer() viewer:Viewer, @Param('vodId') vodId:string, @Body() body:unknown) {
    const input=preparePreviewPayload.pick({count:true,audioMode:true}).strict().parse(body??{});
    await this.catalog.vod(viewer,vodId);
    return this.jobs.enqueue(QUEUES.preparePreview,{vodId,...input});
  }

  @AdminOnly()
  @Post('prepare-streamer/:login')
  async prepareStreamer(@CurrentViewer() viewer:Viewer, @Param('login') login:string, @Body() body:unknown) {
    const input=prepareStreamerPayload.parse({...(z.record(z.unknown()).parse(body??{})),login});
    await this.catalog.streamer(viewer,login);
    for(const id of input.vodIds??[]) {
      const vod=await this.catalog.vod(viewer,id);
      if(vod.streamer!==login)throw new BadRequestException('Эфиры должны принадлежать выбранному стримеру');
    }
    return this.jobs.enqueue(QUEUES.prepareStreamer,input);
  }

  @Post("render/:vodId")
  async render(
    @CurrentViewer() viewer: Viewer | null,
    @Param("vodId") vodId: string,
    @Body() body: unknown,
  ) {
    const input = renderRunPayload.omit({vodId:true}).strict().parse(body??{});
    if (input.testBatch && !viewer?.isAdmin) throw new ForbiddenException('Тестовая подборка доступна администратору');
    if (input.testBatch && (input.count ?? 1) > 100) throw new BadRequestException('В подборке не больше 100 клипов');
    await this.catalog.vod(viewer, vodId);
    const queue=input.audioMode!==undefined || input.skipExisting || input.testBatch ? QUEUES.renderVariant : QUEUES.renderRun;
    return this.jobs.enqueue(queue, {vodId,...input});
  }
}
