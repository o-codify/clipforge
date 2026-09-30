/**
 * Постановка заданий и их состояние.
 *
 * Бэкенд только ставит задания и читает их состояние; выполняет их
 * отдельный процесс-воркер. Так рендер и распознавание не могут
 * подвесить интерфейс, а перезапуск бэкенда не роняет идущую работу.
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import PgBoss from "pg-boss";
import { sql } from "drizzle-orm";

import { PAYLOADS, QUEUES, singletonKey, type QueueName } from "@clipforge/jobs";
import type { Viewer } from "../auth/auth.service.js";
import { enqueueUnique, type Database } from "@clipforge/db";

import { CONFIG, DATABASE, type ApiConfig } from "../config.js";
import { jobMessage } from "./conversation.js";

export interface JobRow extends Record<string, unknown> {
  id: string;
  name: string;
  state: string;
  data: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  output: unknown;
}

@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly log = new Logger("jobs");
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss> | null = null;
  private readonly queues = new Map<QueueName,Promise<void>>();

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  private async queue(): Promise<PgBoss> {
    if (this.boss) return this.boss;
    this.starting ??= (async () => {
      const boss = new PgBoss({
        connectionString: this.config.databaseUrl,
        schema: "jobs",
      });
      boss.on("error", (error) => this.log.error(String(error)));
      await boss.start();
      this.boss = boss;
      return boss;
    })();
    return this.starting;
  }

  /**
   * Поставить задание.
   *
   * Повтор того же задания по тому же объекту отбрасывается: без этого
   * двойное нажатие кнопки ставит вторую загрузку в ту же папку.
   */
  async enqueue<Q extends QueueName>(
    queue: Q,
    payload: unknown,
  ): Promise<{ id: string | null; queued: boolean }> {
    const boss = await this.queue();
    let ready = this.queues.get(queue);
    if (!ready) {
      ready = boss.createQueue(queue).catch(error=>{this.queues.delete(queue);throw error;});
      this.queues.set(queue,ready);
    }
    await ready;
    const parsed = PAYLOADS[queue].parse(payload);

    const key = singletonKey(queue, parsed as never);
    const id = await enqueueUnique(this.db, queue, key, () => boss.send(queue, parsed as object, {
      singletonKey: singletonKey(queue, parsed as never),
      retryLimit: 2,
      retryDelay: 60, retryBackoff: true,
      // pg-boss requires strictly less than 24h (including explicit sends).
      expireInSeconds: queue===QUEUES.prepareStreamer?24*3600-1:6*3600,
    }));
    if (id) return {id,queued:true};
    // Return a trackable handle even when a repeated request is coalesced.
    const [existing] = await this.db.execute<{id:string}>(sql`select id::text from jobs.job
      where name=${queue} and singleton_key=${key} order by created_on desc limit 1`);
    return {id:existing?.id??null,queued:false};
  }

  /**
   * Снять задание.
   *
   * Стоящее в очереди снимается мгновенно. Выполняющееся помечается
   * снятым, и воркер останавливается на ближайшей границе: между шагами
   * конвейера или между клипами рендера. Уже идущий процесс ffmpeg или
   * загрузки дорабатывает свой кусок - убивать его на середине значит
   * оставить битый файл.
   */
  async cancel(id: string): Promise<{ cancelled: boolean }> {
    const [row] = await this.db.execute<{ name: string; state: string }>(sql`
      select name, state from jobs.job where id = ${id}::uuid
    `);
    if (!row) return { cancelled: false };
    if (!["created", "active", "retry"].includes(row.state)) {
      return { cancelled: false };
    }
    const boss = await this.queue();
    await boss.cancel(row.name, id);
    return { cancelled: true };
  }

  /** Resume the same draft batch: its checkpoints and publication scope use this ID. */
  async resumeBatch(id: string): Promise<{id:string;resumed:boolean}> {
    const [row] = await this.db.execute<{name:string;state:string;singletonKey:string}>(sql`
      select name,state,singleton_key as "singletonKey" from jobs.job where id=${id}::uuid`);
    if (!row) throw new NotFoundException('Подборка не найдена');
    if (row.name!==QUEUES.prepareStreamer) throw new BadRequestException('Можно продолжить только подборку клипов');
    if (['created','retry','active'].includes(row.state)) return {id,resumed:false};
    if (row.state!=='failed') throw new BadRequestException('Продолжить можно только подборку после сбоя');
    const boss=await this.queue();
      const resumed=await enqueueUnique(this.db,QUEUES.prepareStreamer,row.singletonKey,async()=>{
        const children=await this.db.execute<{id:string}>(sql`select id::text from jobs.job
          where name=${QUEUES.prepareBatchVod} and data->>'batchId'=${id} and state='failed'`);
        for(const child of children)await boss.retry(QUEUES.prepareBatchVod,child.id);
        await boss.retry(QUEUES.prepareStreamer,id);
      const [current]=await this.db.execute<{state:string}>(sql`select state from jobs.job where id=${id}::uuid`);
      return current&&['retry','active','completed'].includes(current.state)?id:null;
    });
    return {id,resumed:resumed===id};
  }

  /** Последние задания - для панели «что сейчас происходит». */
  async recent(viewer: Viewer, limit = 30): Promise<JobRow[]> {
    return this.describe(await this.db.execute<JobRow>(sql`
      select id::text, name, state, data,
             created_on as "createdAt", started_on as "startedAt",
             completed_on as "completedAt", output
      from jobs.job j
      where ${this.scope(viewer)}
      order by created_on desc
      limit ${limit}
    `), viewer);
  }

  /** Что выполняется прямо сейчас. */
  async active(viewer: Viewer): Promise<JobRow[]> {
    return this.describe(await this.db.execute<JobRow>(sql`
      select id::text, name, state, data,
             created_on as "createdAt", started_on as "startedAt",
             completed_on as "completedAt", output
      from jobs.job j
      where state in ('created', 'active', 'retry') and ${this.scope(viewer)}
      order by created_on
    `), viewer);
  }

  private async describe(rows: JobRow[], viewer: Viewer): Promise<JobRow[]> {
    if (!rows.length) return rows;
    const objects = await this.db.execute<{id:string; objectTitle:string; objectHref:string|null; streamerName:string|null; stage:string|null}>(sql`
      select j.id::text, coalesce(v.title, s.display_name, s.login,
        case when j.name='light.refresh-youtube' then 'YouTube' else 'Материал больше недоступен' end) as "objectTitle",
        case when v.id is not null then '/vods/' || v.id when s.login is not null then '/streamers/' || s.login else null end as "objectHref",
        coalesce(s.display_name, s.login) as "streamerName", s.login as streamer, s.avatar,
        (select message from job_events e where e.job_id=j.id and message like 'шаг %' order by e.id desc limit 1) as stage
      from jobs.job j
      left join publications p on p.id = j.data->>'publicationId'
      left join clips c on c.id = p.clip_id
      left join vods v on v.id = coalesce(j.data->>'vodId', c.vod_id)
      left join streamers s on s.login = coalesce(v.streamer, j.data->>'login', c.streamer)
      where j.id in (${sql.join(rows.map(row => sql`${row.id}::uuid`), sql`, `)})
    `);
    return rows.map(row => ({ ...row, ...objects.find(object => object.id === row.id),
      output: viewer.isAdmin ? row.output : row.state === 'failed' ? null : row.output }));
  }

  private scope(viewer: Viewer) {
    const channel = viewer.actingAs;
    if (!channel && (viewer.isAdmin || viewer.role === "moderator")) return sql`true`;
    return sql`(j.data->>'login' = ${channel ?? "__unlinked_account__"}
      or exists (select 1 from vods v where v.id = j.data->>'vodId' and v.streamer = ${channel ?? "__unlinked_account__"})
      or exists (select 1 from publications p join clips c on c.id = p.clip_id
        where p.id = j.data->>'publicationId' and c.streamer = ${channel ?? "__unlinked_account__"}))`;
  }

  /** Group before pagination: busy channels cannot displace other channels' tasks. */
  private groupSource(viewer: Viewer) {
    return sql`with source as (
      select j.id::text, j.name, j.state::text, j.data, j.created_on, j.started_on, j.completed_on, j.output
      from jobs.job j where ${this.scope(viewer)}
      union all
      select id::text, name, case when state='active' and started_at < now()-interval '6 hours' then 'expired' else state end,
        '{}'::jsonb, started_at, started_at, completed_at, output
      from automation_runs where ${viewer.isAdmin}
    ), labeled as (
      select j.*, coalesce(s.login, v.streamer, j.data->>'login', c.streamer) as streamer,
        coalesce(s.display_name,s.login,j.data->>'login') as "streamerName", s.avatar,
        coalesce(v.title, s.display_name, s.login) as "objectTitle",
        case when v.id is not null then '/vods/' || v.id else null end as "objectHref"
      from source j
      left join publications p on p.id=j.data->>'publicationId'
      left join clips c on c.id=p.clip_id
      left join vods v on v.id=coalesce(j.data->>'vodId',c.vod_id)
      left join streamers s on s.login=coalesce(v.streamer,j.data->>'login',c.streamer)
    )`;
  }

  async groups(viewer: Viewer) {
    const rows = await this.db.execute<JobRow & {streamer:string|null; runs:number}>(sql`${this.groupSource(viewer)}, ranked as (
      select *, row_number() over task as position,
        (count(*) over counts)::int as runs,
        (count(*) filter(where state='active') over counts)::int as active,
        (count(*) filter(where state in ('created','retry')) over counts)::int as waiting,
        (count(*) filter(where state='completed') over counts)::int as completed,
        (count(*) filter(where state in ('failed','expired')) over counts)::int as failed
      from labeled
      window task as (partition by name,streamer order by created_on desc,id desc), counts as (partition by name,streamer)
    ) select id,name,state,data,streamer,"streamerName",avatar,"objectTitle","objectHref",
      created_on as "createdAt",started_on as "startedAt",completed_on as "completedAt",
      runs,active,waiting,completed,failed from ranked where position=1 order by active desc,waiting desc,created_on desc`);
    const groups = rows.map(row => ({...row,recurring: row.runs > 1 || ['light.index-channel','light.refresh-streamer'].includes(row.name) || row.name.startsWith('platform.')}));
    if (viewer.isAdmin) for (const name of ['platform.discovery','platform.metrics','platform.sweep']) {
      if (!groups.some(group=>group.name===name)) groups.push({id:name,name,state:'idle',data:{},streamer:null,createdAt:null,startedAt:null,completedAt:null,runs:0,active:0,waiting:0,completed:0,failed:0,recurring:true} as unknown as typeof groups[number]);
    }
    return groups;
  }

  async groupRuns(viewer: Viewer, input: {name:string;streamer:string;offset:number}) {
    const rows = await this.db.execute<JobRow>(sql`${this.groupSource(viewer)}
      select id,name,state,data,streamer,"streamerName",avatar,"objectTitle","objectHref",
        created_on as "createdAt",started_on as "startedAt",completed_on as "completedAt",
        case when ${viewer.isAdmin} or state not in ('failed','expired') then output else null end as output
      from labeled where name=${input.name} and coalesce(streamer,'')=${input.streamer}
      order by created_on desc,id desc limit 31 offset ${input.offset}`);
    return {runs:rows.slice(0,30),nextOffset:rows.length>30?input.offset+30:null};
  }

  async status(viewer:Viewer, id:string) {
    const [job]=await this.db.execute<{id:string;state:string;output:unknown}>(sql`select id::text,state,output from jobs.job j where id=${id}::uuid and ${this.scope(viewer)}`);
    if (!job) throw new NotFoundException('Задание не найдено');
    return job;
  }

  async events(viewer: Viewer, id: string) {
    if (!viewer.isAdmin) return [];
    return this.db.execute(sql`select e.id, e.message, e.created_at as "createdAt"
      from (select * from job_events where job_id = ${id}::uuid order by id desc limit 100) e
      join jobs.job j on j.id = e.job_id where ${this.scope(viewer)} order by e.id`);
  }

  async conversation(viewer: Viewer) {
    const rows=await this.db.execute<JobRow>(sql`
      select * from (
        select distinct on (coalesce(data->>'vodId',data->>'login',data->>'publicationId',id::text))
          id::text,name,state,data,created_on as "createdAt",started_on as "startedAt",completed_on as "completedAt",output
        from jobs.job j where ${this.scope(viewer)}
        order by coalesce(data->>'vodId',data->>'login',data->>'publicationId',id::text),created_on desc
      ) objects order by "createdAt" desc limit 40
    `);
    const jobs=await this.describe(rows,viewer);
    if(!jobs.length)return [];
    const events=await this.db.execute<{jobId:string;message:string}>(sql`
      select j.id::text as "jobId", e.message from jobs.job j
      cross join lateral (select id,message from job_events where job_id=j.id order by id desc limit 1000) e
      where j.id in (${sql.join(jobs.map(job=>sql`${job.id}::uuid`),sql`, `)}) order by e.id
    `);
    return jobs.map(job=>jobMessage(job,events.filter(event=>event.jobId===job.id),false));
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 5000 });
  }

  static readonly QUEUES = QUEUES;
}
