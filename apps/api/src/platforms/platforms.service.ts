/**
 * Площадки публикации: подключение аккаунтов и постановка публикаций.
 *
 * Подключение - классический OAuth: генерируется одноразовый state,
 * админ уходит на страницу согласия Google, возвращается на callback,
 * код меняется на refresh token, тот сохраняется. Дальше воркер сам
 * обновляет access token перед каждой загрузкой.
 */
import { randomUUID } from "node:crypto";

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";

import { clips, games, streamers, runs, platformAccounts, publications, runtimeValue, youtubeDestination, beginYoutubeDisconnect, forgetYoutubeAccount, type Database } from "@clipforge/db";
import { QUEUES, batchPublicationKey,publicationFeedKey,type PublicationFeed, type BatchPublicationPolicy, type PayloadOf } from "@clipforge/jobs";
import {
  authUrl,
  exchangeCode,
  myChannel,
  refreshAccessToken,
  suggestVideoMetadata, validateVideoMetadata, prepareVideoMetadata, type VideoMetadata,
  revokeToken, YoutubeAccessRevokedError,
  type YoutubeApp,
} from "@clipforge/youtube";

import { CONFIG, DATABASE, type ApiConfig } from "../config.js";
import { JobsService } from "../jobs/jobs.service.js";

/** Статусы, в которых публикацию не надо ставить второй раз. */
const IN_FLIGHT = new Set(["queued", "uploading", "uploaded", "processing", "published", "takedown"]);

@Injectable()
export class PlatformsService {
  /** Одноразовые state для OAuth: значение -> срок годности. */
  private readonly states = new Map<string, number>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ApiConfig,
    private readonly jobs: JobsService,
  ) {}

  private get youtube(): YoutubeApp {
    if (!this.config.youtube) {
      throw new BadRequestException(
        "не заданы YOUTUBE_CLIENT_ID и YOUTUBE_CLIENT_SECRET в .env",
      );
    }
    return this.config.youtube;
  }

  private get redirectUri(): string {
    return `${this.config.apiOrigin}/api/platforms/youtube/callback`;
  }

  /** Подключённые аккаунты. Секреты наружу не отдаются никогда. */
  async accounts() {
    return this.db
      .select({
        id: platformAccounts.id,
        platform: platformAccounts.platform,
        label: platformAccounts.label,
        externalId: platformAccounts.externalId,
        createdAt: platformAccounts.createdAt,
        verifiedAt: platformAccounts.verifiedAt,
        disconnectRequestedAt: platformAccounts.disconnectRequestedAt,
      })
      .from(platformAccounts);
  }

  async batches() {
    return this.db.execute(sql`select r.value as policy, j.state as "jobState",coalesce((j.data->>'count')::int,jsonb_array_length(j.data->'clipIds')) as target,
      (select count(*)::int from platform_runtime u where u.key like 'upload-attempt:%' and u.value->>'channel'=r.value->>'channelId' and u.updated_at>now()-interval '24 hours') as "attempts24h",
      (select count(*)::int from clips c join runs n on n.id=c.run_id
        where n.settings->>'jobId'=r.value->>'jobId' and c.archived_at is null and c.state<>'blocked') as ready,
      (select count(*)::int from publications p join clips c on c.id=p.clip_id join runs n on n.id=c.run_id
        where n.settings->>'jobId'=r.value->>'jobId' and p.account=r.value->>'channelId' and p.media_id is not null) as uploaded
      from platform_runtime r left join jobs.job j on j.id::text=r.value->>'jobId'
      where r.key like 'batch-publication:%' and r.value->>'feedId' is null order by r.updated_at desc limit 50`);
  }

  async destination(login:string) { return youtubeDestination(this.db,login); }

  async feeds(){
    return this.db.execute(sql`select f.value as policy,s.display_name as name,s.avatar,g.title as game,a.label as channel,
      (select count(*)::int from clips c join runs r on r.id=c.run_id join platform_runtime p on p.key='batch-publication:'||(r.settings->>'jobId')
        where p.value->>'feedId'=f.value->>'id' and c.archived_at is null and c.state in ('draft','ready')) as ready,
      (select count(*)::int from publications u join clips c on c.id=u.clip_id join runs r on r.id=c.run_id join platform_runtime p on p.key='batch-publication:'||(r.settings->>'jobId')
        where p.value->>'feedId'=f.value->>'id' and u.account=f.value->>'channelId' and u.media_id is not null) as uploaded
      from platform_runtime f join streamers s on s.login=f.value->>'login' join games g on g.slug=f.value->>'game'
      left join platform_accounts a on a.external_id=f.value->>'channelId' and a.platform='youtube'
      where f.key like 'publication-feed:%' order by f.key`);
  }

  async configureFeed(options:Pick<PublicationFeed,'login'|'game'|'startVodId'|'startOffsetSeconds'|'channelId'|'enabled'|'intervalMinutes'|'audioMode'>){
    return this.db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(740025)`);
      const [source]=await tx.execute<{publishedAt:string;chapters:{title:string;start:number;end:number}[]}>(sql`select published_at as "publishedAt",chapters from vods where id=${options.startVodId} and streamer=${options.login}`);
      if(!source?.publishedAt)throw new BadRequestException('Начальный эфир должен принадлежать выбранному стримеру');
      if(!(await tx.execute(sql`select 1 from games where slug=${options.game}`)).length)throw new BadRequestException('Игра не найдена');
      const [account]=await tx.execute(sql`select 1 from platform_accounts where platform='youtube' and external_id=${options.channelId}
        and disconnect_requested_at is null and credentials->>'refreshToken' is not null`);
      if(options.enabled&&!account)throw new BadRequestException('Подключите выбранный YouTube-канал');
      const key=publicationFeedKey(options.login,options.game);
      const [old]=await tx.execute<{value:PublicationFeed}>(sql`select value from platform_runtime where key=${key} for update`);
      if(old&&(old.value.channelId!==options.channelId||old.value.startVodId!==options.startVodId))throw new BadRequestException('Канал и начальный эфир действующей очереди менять нельзя');
      const startOffsetSeconds=options.startOffsetSeconds??old?.value.startOffsetSeconds??0;
      if(startOffsetSeconds<(old?.value.startOffsetSeconds??0))throw new BadRequestException('Начало действующей очереди можно переносить только вперёд');
      if(startOffsetSeconds>0&&!source.chapters.some(c=>c.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'_').replace(/^_|_$/g,'')===options.game&&startOffsetSeconds>=c.start&&startOffsetSeconds<c.end))throw new BadRequestException('Начало очереди должно находиться внутри выбранной игры');
      const value:PublicationFeed={...old?.value,...options,startOffsetSeconds,id:old?.value.id??randomUUID(),since:new Date(source.publishedAt).toISOString(),
        state:options.enabled?'waiting':'paused',error:null,authorizedAt:new Date().toISOString()};
      await tx.execute(sql`insert into platform_runtime(key,value) values(${key},${JSON.stringify(value)}::jsonb)
        on conflict(key) do update set value=excluded.value,updated_at=now()`);
      await tx.execute(sql`update platform_runtime set value=value||${JSON.stringify({enabled:value.enabled,intervalMinutes:value.intervalMinutes})}::jsonb,updated_at=now()
        where key like 'batch-publication:%' and value->>'feedId'=${value.id}`);
      // Advancing past an intro retires its old attempts and publication policies.
      // Keep the record so retry/restart cannot silently re-enable those clips.
      const excluded=await tx.execute<{key:string;value:{jobId:string}}>(sql`select key,value from platform_runtime
        where key like ${'feed-window:'+value.id+':%'} and value->>'vodId'=${value.startVodId}
        and (value->>'start')::numeric<${startOffsetSeconds} for update`);
      for(const item of excluded){
        await tx.execute(sql`update platform_runtime set value=value||'{"state":"done","excluded":true}'::jsonb,updated_at=now() where key=${item.key}`);
        await tx.execute(sql`update platform_runtime set value=value||'{"enabled":false,"state":"excluded"}'::jsonb,updated_at=now() where key=${batchPublicationKey(item.value.jobId)}`);
        await tx.execute(sql`update jobs.job set state='cancelled',completed_on=now() where id=${item.value.jobId}::uuid and state in ('created','retry','active')`);
        await tx.execute(sql`update clips c set archived_at=now(),archive_reason='excluded-intro' from runs r
          where r.id=c.run_id and r.settings->>'jobId'=${item.value.jobId} and c.archived_at is null
          and not exists(select 1 from publications p where p.clip_id=c.id and (p.media_id is not null or p.status in ('queued','uploading','processing')))`);
      }
      if(value.enabled){
        const failed=await tx.execute<{key:string;value:Record<string,unknown>}>(sql`select key,value from platform_runtime
          where key like ${'feed-window:'+value.id+':%'} and value->>'state'='failed' for update`);
        for(const item of failed){
          const jobId=randomUUID(),window={...item.value,jobId,state:'reserved',error:null,createdAt:new Date().toISOString()};
          const policy:BatchPublicationPolicy={jobId,login:value.login,channelId:value.channelId,enabled:true,intervalMinutes:value.intervalMinutes,
            dailyLimit:null,privacy:'public',authorizedAt:value.authorizedAt,state:'waiting-clips',feedId:value.id,game:value.game};
          await tx.execute(sql`update platform_runtime set value=${JSON.stringify(window)}::jsonb,updated_at=now() where key=${item.key}`);
          await tx.execute(sql`insert into platform_runtime(key,value) values(${batchPublicationKey(jobId)},${JSON.stringify(policy)}::jsonb)`);
        }
      }
      return value;
    });
  }

  async configureBatch(id:string,options:Omit<Pick<BatchPublicationPolicy,'enabled'|'channelId'|'intervalMinutes'|'dailyLimit'|'privacy'>,'channelId'> & {channelId?:string}) {
    return this.db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(740025)`);
      const [job]=await tx.execute<{data:{login:string};state:string}>(sql`select j.data||jsonb_build_object('login',coalesce(j.data->>'login',v.streamer)) as data,j.state from jobs.job j
        left join vods v on v.id=j.data->>'vodId' where j.id=${id}::uuid and j.name in (${QUEUES.prepareStreamer},${QUEUES.restoreAudio},${QUEUES.preparePreview})`);
      if(!job) throw new NotFoundException('Подборка не найдена');
      if(options.enabled&&job.state==='cancelled')throw new BadRequestException('Подборка отменена');
      const channelId=options.channelId??(await youtubeDestination(tx as unknown as Database,job.data.login)).channelId;
      const [account]=await tx.select({id:platformAccounts.id}).from(platformAccounts).where(and(eq(platformAccounts.platform,'youtube'),eq(platformAccounts.externalId,channelId),isNull(platformAccounts.disconnectRequestedAt))).for('update');
      if(options.enabled&&!account)throw new BadRequestException('Подключите выбранный YouTube-канал');
      const key=batchPublicationKey(id);
      const [saved]=await tx.execute<{value:BatchPublicationPolicy}>(sql`select value from platform_runtime where key=${key} for update`);
      if(saved?.value.pendingPublicationId&&saved.value.channelId!==channelId)throw new BadRequestException('Сначала завершите текущую публикацию');
      const policy:BatchPublicationPolicy={...saved?.value,...options,channelId,jobId:id,login:job.data.login,
        authorizedAt:new Date().toISOString(),state:options.enabled?'waiting':'paused',error:null};
      await tx.execute(sql`insert into platform_runtime(key,value) values(${key},${JSON.stringify(policy)}::jsonb)
        on conflict(key) do update set value=excluded.value,updated_at=now()`);
      return policy;
    });
  }

  async pauseBatch(id:string) {
    await this.db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(740025)`);
      await tx.execute(sql`update platform_runtime set value=value || '{"enabled":false,"state":"paused"}'::jsonb,updated_at=now()
        where key=${batchPublicationKey(id)}`);
    });
    return {paused:true};
  }

  /** Stored facts only: reading this endpoint never uploads or contacts Google. */
  async publication(id:string) {
    const [row] = await this.db.execute<{id:string;videoId:string|null;status:string;collectedAt:Date|null}>(sql`
      select p.id,p.clip_id as "clipId",p.media_id as "videoId",p.url,p.status,p.title,p.caption as description,
        p.privacy as "storedPrivacy",p.error,p.published_at as "publishedAt",p.updated_at as "updatedAt",
        a.id as "accountId",a.label as channel,c.streamer,
        m.extended->>'privacy' as "actualPrivacy",m.collected_at as "collectedAt",
        m.views,m.likes,m.comments,m.extended as restrictions,
        j.id::text as "jobId",j.state as "jobState"
      from publications p join clips c on c.id=p.clip_id
      join platform_accounts a on a.platform=p.platform and a.external_id=p.account
      left join lateral (select * from publication_metrics where publication_id=p.id
        order by collected_at desc,id desc limit 1) m on true
      left join lateral (select id,state from jobs.job where name in (${QUEUES.publishClip},${QUEUES.publishBatchClip})
        and data->>'publicationId'=p.id order by created_on desc limit 1) j on true
      where p.id=${id} and p.platform='youtube' and a.disconnect_requested_at is null`);
    if(!row) throw new NotFoundException('Публикация недоступна');
    return {...row,stale:!row.collectedAt||Date.now()-new Date(row.collectedAt).getTime()>75*60000,
      // videos.list reports regional/age restrictions, not Content ID claim details.
      copyrightClaim:'unknown' as const};
  }

  async refresh(payload:PayloadOf<'light.refresh-youtube'>) {
    if(payload.publicationId) {
      const publication = await this.publication(payload.publicationId);
      if(!publication.videoId || publication.status==='takedown') throw new BadRequestException('Видео ещё не загружено или больше недоступно');
    }
    const job = await this.jobs.enqueue(QUEUES.refreshYoutube,payload);
    return {jobId:job.id,queued:job.queued};
  }

  async check(accountId?: string) {
    const [account] = await this.db.select().from(platformAccounts).where(and(eq(platformAccounts.platform,"youtube"),accountId ? eq(platformAccounts.id,accountId) : undefined));
    if (!account?.credentials.refreshToken) return { state:"missing", reason:"Подключите YouTube-канал" };
    if (account.disconnectRequestedAt) return {state:"pending",reason:"Отключение канала выполняется"};
    try {
      const token = await refreshAccessToken(this.youtube,account.credentials.refreshToken);
      const channel = await myChannel(token);
      if (channel?.id !== account.externalId) throw new Error("Подключение принадлежит другому каналу");
      const saved=await this.db.update(platformAccounts).set({label:channel.title,verifiedAt:new Date()})
        .where(and(eq(platformAccounts.id,account.id),isNull(platformAccounts.disconnectRequestedAt))).returning({id:platformAccounts.id});
      if(!saved.length) return {state:"missing",reason:"Канал отключён"};
      const result = { state:"ok", channel:channel.title };
      await runtimeValue(this.db,"youtube-access",result);
      return result;
    } catch(error) {
      if(error instanceof YoutubeAccessRevokedError) await forgetYoutubeAccount(this.db,account.id);
      const result = { state:"error", reason:"Доступ недействителен. Подключите YouTube повторно. Для приложения Google в режиме Testing токены могут истекать." };
      await runtimeValue(this.db,"youtube-access",result);
      return result;
    }
  }

  /** Адрес страницы согласия Google для подключения YouTube-канала. */
  connectUrl(): { url: string } {
    const state = randomUUID();
    this.states.set(state, Date.now() + 10 * 60 * 1000);
    // Просроченные state копятся только при брошенных подключениях -
    // чистка попутная, отдельного таймера не нужно.
    for (const [key, expires] of this.states) {
      if (expires < Date.now()) this.states.delete(key);
    }
    return { url: authUrl(this.youtube, this.redirectUri, state) };
  }

  /**
   * Возврат с согласия. Callback открыт (браузер приходит с адреса
   * Google), подлинность подтверждает одноразовый state.
   */
  async handleCallback(code: string, state: string): Promise<void> {
    const expires = this.states.get(state);
    this.states.delete(state);
    if (!expires || expires < Date.now()) {
      throw new BadRequestException("подключение устарело, начните заново");
    }

    const { accessToken, refreshToken } = await exchangeCode(
      this.youtube,
      this.redirectUri,
      code,
    );
    const channel = await myChannel(accessToken);
    if (!channel) throw new BadRequestException("у аккаунта Google нет YouTube-канала");

    const saved = await this.db
      .insert(platformAccounts)
      .values({
        id: randomUUID(),
        platform: "youtube",
        label: channel.title,
        externalId: channel.id,
        credentials: { refreshToken },
        verifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [platformAccounts.platform, platformAccounts.externalId],
        set: { label: channel.title, credentials: { refreshToken }, verifiedAt:new Date() },
        setWhere:isNull(platformAccounts.disconnectRequestedAt),
      }).returning({id:platformAccounts.id});
    if(!saved.length) throw new BadRequestException("Отключение канала ещё выполняется. Дождитесь завершения и подключите его снова.");
  }

  async disconnect(id: string): Promise<{state:"disconnected"|"pending"}> {
    const account=await beginYoutubeDisconnect(this.db,id);
    if(!account) return {state:"disconnected"};
    try { if(account.credentials.refreshToken) await revokeToken(account.credentials.refreshToken); }
    catch { return {state:"pending"}; } // Durable intent: worker retries automatically; no new uploads are accepted.
    await forgetYoutubeAccount(this.db,id);
    return {state:"disconnected"};
  }

  /**
   * Поставить клип на публикацию.
   *
   * Ряд publications создаётся здесь, воркер только выполняет. Повторная
   * постановка идущей или вышедшей публикации не создаёт дубля - у пары
   * (клип, площадка, аккаунт) одно место.
   */
  async preview(clipId: string) {
    const [clip] = await this.db.select({ login:clips.streamer,
      displayName:streamers.displayName, gameTitle:games.title })
      .from(clips).innerJoin(runs,eq(clips.runId,runs.id)).innerJoin(streamers,eq(clips.streamer,streamers.login)).leftJoin(games,eq(clips.game,games.slug))
      .where(and(eq(clips.id,clipId),eq(clips.state,"ready"),sql`${clips.archivedAt} is null`,
        sql`coalesce(${runs.settings} #>> array['renderedClips',${clips.id},'protection','autoVerifiedAt'], ${runs.settings} #>> array['renderedClips',${clips.id},'protection','reviewedAt'], ${runs.settings} #>> array['renderedClips',${clips.id},'protection','disabledAt']) is not null`));
    if(!clip) throw new NotFoundException("Клип недоступен для публикации");
    return { ...suggestVideoMetadata({...clip,displayName:clip.displayName ?? clip.login}),
      defaultAccountId:(await this.destination(clip.login)).account?.id??null,
      accounts:(await this.accounts()).filter(account=>account.platform==="youtube"&&!account.disconnectRequestedAt) };
  }

  async publish(clipId: string, metadata: VideoMetadata & {accountId:string}) {
    metadata = prepareVideoMetadata(metadata);
    try { validateVideoMetadata(metadata); } catch(error) { throw new BadRequestException((error as Error).message); }
    const [clip] = await this.db
      .select({ id: clips.id, state: clips.state, archivedAt: clips.archivedAt,
        reviewedAt: sql<string | null>`coalesce(${runs.settings} #>> array['renderedClips',${clips.id},'protection','autoVerifiedAt'], ${runs.settings} #>> array['renderedClips',${clips.id},'protection','reviewedAt'], ${runs.settings} #>> array['renderedClips',${clips.id},'protection','disabledAt'])` })
      .from(clips).innerJoin(runs,eq(clips.runId,runs.id))
      .where(eq(clips.id, clipId));
    if (!clip) throw new NotFoundException("клип не найден");
    if (clip.state !== "ready" || clip.archivedAt || !clip.reviewedAt) {
      throw new BadRequestException("Для публикации нужна завершённая обработка рекламы");
    }

    const access = await this.check(metadata.accountId);
    if (access.state !== "ok") throw new BadRequestException("Подключите YouTube повторно в настройках");

    const queued=await this.db.transaction(async tx=>{
    const [account] = await tx
      .select()
      .from(platformAccounts)
      .where(and(eq(platformAccounts.platform, "youtube"),eq(platformAccounts.id,metadata.accountId),isNull(platformAccounts.disconnectRequestedAt))).for("update");
    if (!account) {
      throw new BadRequestException("YouTube не подключён: сначала подключите канал в настройках");
    }

    const [existing] = await tx
      .select({ id: publications.id, status: publications.status, error: publications.error,mediaId:publications.mediaId,
        title:publications.title,caption:publications.caption,privacy:publications.privacy })
      .from(publications)
      .where(
        and(
          eq(publications.clipId, clipId),
          eq(publications.platform, "youtube"),
          eq(publications.account, account.externalId),
        ),
      );

    let publicationId: string;
    if (existing?.error?.startsWith("[upload-uncertain]")) {
      throw new BadRequestException("Исход предыдущей загрузки неизвестен. Проверьте канал: повторная отправка может создать дубль.");
    }
    if (existing && (existing.mediaId || IN_FLIGHT.has(existing.status))) {
      // Уже в работе или вышла - просто вернуть, кнопка не дублирует.
      return { publicationId: existing.id, send:existing.status==='queued'&&!existing.mediaId,existing:true };
    } else if (existing) {
      const [session]=await tx.execute(sql`select 1 from youtube_upload_sessions where publication_id=${existing.id}`);
      if(session && (existing.title!==metadata.title || existing.caption!==metadata.description || existing.privacy!==metadata.privacy)) {
        throw new BadRequestException('Загрузка уже началась. Продолжите её с прежними названием, описанием и видимостью.');
      }
      publicationId = existing.id;
      await tx
        .update(publications)
        .set({ status: "queued", error: null, title:metadata.title,caption:metadata.description,privacy:metadata.privacy })
        .where(eq(publications.id, existing.id));
    } else {
      publicationId = randomUUID();
      await tx.insert(publications).values({
        id: publicationId,
        clipId,
        platform: "youtube",
        account: account.externalId,
        status: "queued",
        title:metadata.title,caption:metadata.description,privacy:metadata.privacy,
      });
    }

    return {publicationId,send:true,existing:false};
    });
    const {publicationId}=queued;
    if(!queued.send) {
      const [job] = await this.db.execute<{id:string}>(sql`select id::text from jobs.job
        where name=${QUEUES.publishClip} and data->>'publicationId'=${publicationId} order by created_on desc limit 1`);
      return {publicationId,jobId:job?.id??null,queued:false,existing:true};
    }
    try {
      const job = await this.jobs.enqueue(QUEUES.publishClip, { publicationId });
      return {publicationId,jobId:job.id,queued:job.queued,existing:queued.existing};
    } catch(error) {
      await this.db.update(publications).set({status:"failed",error:"Не удалось поставить в очередь"})
        .where(and(eq(publications.id,publicationId),eq(publications.status,'queued')));
      throw error;
    }
  }
}
