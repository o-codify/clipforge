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
        // Readiness includes the schema used by channel access, not just a live socket.
        this.db.sql`select verified_at, disconnect_requested_at from platform_accounts limit 0`,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Database timeout")), 3000); }),
      ]);
      if (process.env.WORKER_HEARTBEAT_FILE) {
        const beat = JSON.parse(await readFile(process.env.WORKER_HEARTBEAT_FILE, "utf8"));
        if (beat.instance !== process.env.RUNTIME_INSTANCE || !Number.isFinite(beat.at) ||
            Date.now() - beat.at > 35_000 || !["online", "standby"].includes(beat.state)) throw new Error("Worker unavailable");
        process.kill(beat.pid, 0);
        if (beat.state === "standby") {
          const [active] = await this.db.sql`select 1 from platform_runtime
            where key = 'control' and value->>'state' = 'online'
              and updated_at > now() - interval '35 seconds'
              and exists (select 1 from pg_locks where locktype = 'advisory'
                and classid = 0 and objid = 740021 and objsubid = 1 and granted
                and database = (select oid from pg_database where datname = current_database()))`;
          if (!active) throw new Error("Active controller unavailable");
        }
      }
      return { status: "ready", release: process.env.RELEASE_SHA ?? "local" };
    } catch {
      // Public probe exposes no database credentials or operational details.
      throw new ServiceUnavailableException("Not ready");
    } finally { clearTimeout(timer); }
  }
}
