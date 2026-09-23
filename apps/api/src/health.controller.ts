import { readFile } from "node:fs/promises";
import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import type { Database } from "@clipforge/db";
import { Public } from "./auth/auth.guard.js";
import { DATABASE } from "./config.js";

@Controller("api/health")
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Public()
  @Get("live")
  live() { return { status: "up" }; }

  @Public()
  @Get("ready")
  async ready() {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.db.sql`select 1`,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Database timeout")), 3000); }),
      ]);
      if (process.env.WORKER_HEARTBEAT_FILE) {
        const beat = JSON.parse(await readFile(process.env.WORKER_HEARTBEAT_FILE, "utf8"));
        if (beat.instance !== process.env.RUNTIME_INSTANCE || !Number.isFinite(beat.at) ||
            Date.now() - beat.at > 35_000 || beat.state !== "online") throw new Error("Worker unavailable");
        process.kill(beat.pid, 0);
      }
      return { status: "ready", release: process.env.RELEASE_SHA ?? "local" };
    } catch {
      // Public probe exposes no database credentials or operational details.
      throw new ServiceUnavailableException("Not ready");
    } finally { clearTimeout(timer); }
  }
}
