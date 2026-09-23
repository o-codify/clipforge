import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { runtimeValue, youtubeDerivedMetricsAllowed, type Database } from "@clipforge/db";
import { z } from "zod";
import { DATABASE } from "./config.js";
import { AdminOnly, CurrentViewer } from "./auth/auth.guard.js";
import type { Viewer } from "./auth/auth.service.js";

@Controller("api/operations")
export class OperationsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  async status(@CurrentViewer() viewer: Viewer) {
    const rows = await this.db.execute<{ key: string; value: Record<string, unknown>; updatedAt: Date }>(sql`select * from platform_runtime where key in ('worker','settings','scheduler','discovery','metrics','storage','youtube-access')`);
    const worker = rows.find(r => r.key === "worker");
    const online = worker?.value.state === "online" && Date.now() - new Date(worker.updatedAt).getTime() < 35000;
    if (!viewer.isAdmin) return { online: !!online };
    return { online: !!online, runtime: Object.fromEntries(rows.map(r => [r.key, { ...r.value, updatedAt: r.updatedAt }])),
      twitchConfigured: !!process.env.TWITCH_CLIENT_ID && !!process.env.TWITCH_CLIENT_SECRET,
      autoPublishEnabled: process.env.AUTO_PUBLISH_ENABLED === "true" };
  }

  @AdminOnly()
  @Post("pause")
  async pause(@Body() body: unknown) {
    const { paused } = z.object({ paused: z.boolean() }).parse(body);
    await this.db.execute(sql`insert into platform_runtime(key,value) values ('settings', ${JSON.stringify({paused})}::jsonb)
      on conflict(key) do update set value=platform_runtime.value || excluded.value, updated_at=now()`);
    return { paused };
  }

  @AdminOnly()
  @Get("analytics")
  async analytics() {
    if(!await youtubeDerivedMetricsAllowed(this.db))return [];
    return this.db.execute(sql`select c.streamer, c.trigger, count(*)::int as samples,
      round(avg(m.views))::int as "averageViews", max(m.collected_at) as "lastCollected"
      from clips c join publications p on p.clip_id = c.id
      join lateral (select * from publication_metrics where publication_id = p.id
        and extended->>'privacy' = 'public' order by collected_at desc limit 1) m on true
      where c.archived_at is null
      group by c.streamer, c.trigger order by avg(m.views) desc`);
  }
}
