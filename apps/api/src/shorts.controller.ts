import { Controller, Get, Inject, Query } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { type Database, youtubeDerivedMetricsAllowed } from '@clipforge/db';
import { z } from 'zod';
import { DATABASE } from './config.js';
import { AdminOnly } from './auth/auth.guard.js';

export const shortsQuery=z.object({
  streamer:z.string().max(100).optional(),game:z.string().max(150).optional(),channel:z.string().max(100).optional(),
  privacy:z.enum(['public','private','unlisted']).optional(),search:z.string().max(150).optional(),
  page:z.coerce.number().int().min(1).max(10000).default(1),
  sort:z.enum(['newest','oldest','views','likes']).default('newest'),
  days:z.coerce.number().int().min(1).max(21).default(7),
  video:z.string().max(100).optional(),
});
const base=sql`p.platform='youtube' and p.media_id is not null and p.status<>'takedown' and a.disconnect_requested_at is null`;
function where(q:z.infer<typeof shortsQuery>):SQL {
  return sql`${base}
    ${q.streamer?sql`and c.streamer=${q.streamer}`:sql``}
    ${q.game?sql`and c.game=${q.game}`:sql``}
    ${q.channel?sql`and p.account=${q.channel}`:sql``}
    ${q.privacy?sql`and p.privacy=${q.privacy}`:sql``}
    ${q.video?sql`and p.id=${q.video}`:sql``}
    ${q.search?sql`and (p.title ilike ${'%'+q.search+'%'} or v.title ilike ${'%'+q.search+'%'})`:sql``}`;
}
const joins=sql`from publications p join clips c on c.id=p.clip_id join streamers s on s.login=c.streamer
  left join games g on g.slug=c.game left join vods v on v.id=c.vod_id
  join platform_accounts a on a.platform=p.platform and a.external_id=p.account`;
const latest=sql`left join lateral (select views,likes,comments,collected_at,extended from publication_metrics
  where publication_id=p.id order by collected_at desc,id desc limit 1) m on true`;

@Controller('api/shorts')
@AdminOnly()
export class ShortsController {
  constructor(@Inject(DATABASE) private readonly db:Database){}

  @Get('filters')
  async filters(){
    const rows=await this.db.execute<{streamer:string;name:string;avatar:string|null;game:string|null;gameTitle:string|null;channel:string;channelTitle:string}>(sql`
      select distinct c.streamer,s.display_name as name,s.avatar,c.game,g.title as "gameTitle",p.account as channel,a.label as "channelTitle" ${joins} where ${base}`);
    const unique=(key:keyof typeof rows[number])=>[...new Map(rows.filter(r=>r[key]).map(r=>[r[key],r])).values()];
    return {streamers:unique('streamer').map(r=>({value:r.streamer,label:r.name||r.streamer})),
      games:unique('game').map(r=>({value:r.game,label:r.gameTitle||r.game})),
      channels:unique('channel').map(r=>({value:r.channel,label:r.channelTitle}))};
  }

  @Get()
  async list(@Query() input:unknown){
    const q=shortsQuery.parse(input);
    const order={newest:sql`p.created_at desc`,oldest:sql`p.created_at asc`,views:sql`m.views desc nulls last`,likes:sql`m.likes desc nulls last`}[q.sort];
    const rows=await this.db.execute(sql`select p.id,p.clip_id as "clipId",p.media_id as "videoId",p.title,p.privacy,p.status,p.published_at as "publishedAt",p.created_at as "uploadedAt",
      c.streamer,s.display_name as "streamerName",s.avatar,c.game,g.title as "gameTitle",c.vod_id as "vodId",v.title as "vodTitle",v.published_at as "vodDate",
      c.duration,a.label as channel,m.views,m.likes,m.comments,m.collected_at as "collectedAt",m.extended as details,
      count(*) over()::int as total ${joins} ${latest} where ${where(q)} order by ${order},p.id limit 40 offset ${(q.page-1)*40}`);
    return {rows,page:q.page,total:Number(rows[0]?.total??0),hasMore:Number(rows[0]?.total??0)>q.page*40};
  }

  @Get('analytics')
  async analytics(@Query() input:unknown){
    const q=shortsQuery.parse(input);
    const [summary]=await this.db.execute(sql`select count(*)::int as videos,count(m.views)::int as measured,
      sum(m.views)::text as views,sum(m.likes)::text as likes,sum(m.comments)::text as comments,
      min(m.collected_at) as "oldestCheck",max(m.collected_at) as "lastCheck",
      count(*) filter(where m.collected_at<now()-interval '75 minutes' or m.collected_at is null)::int as stale
      ${joins} ${latest} where ${where(q)}`);
    // A bounded set of individual raw counters. No invented zero before the first measurement.
    const series=await this.db.execute(sql`with selected as (
      select p.id,p.title,p.media_id,c.streamer ${joins} ${latest} where ${where(q)}
      order by m.views desc nulls last,p.id limit 8
    ), samples as (
      select distinct on(m.publication_id,date_trunc('hour',m.collected_at)) m.publication_id,m.collected_at,m.views,m.likes,m.comments
      from publication_metrics m join selected x on x.id=m.publication_id
      where m.collected_at>=now()-${q.days}*interval '1 day'
      order by m.publication_id,date_trunc('hour',m.collected_at),m.collected_at desc,m.id desc
    ) select x.id,x.title,x.media_id as "videoId",x.streamer,m.collected_at as at,m.views,m.likes,m.comments
      from selected x join samples m on m.publication_id=x.id order by m.collected_at,x.id`);
    const aggregate=await this.db.execute(sql`with selected as (select p.id ${joins} where ${where(q)}),
      hourly as (
        select distinct on(m.publication_id,date_trunc('hour',m.collected_at)) m.publication_id,m.views,m.likes,m.comments,
          least(now(),date_trunc('hour',m.collected_at)+interval '1 hour') as at
        from publication_metrics m join selected x on x.id=m.publication_id
        where m.collected_at>=now()-interval '21 days'
        order by m.publication_id,date_trunc('hour',m.collected_at),m.collected_at desc,m.id desc
      ), ranges as (select *,lead(at,1,now()+interval '1 hour') over(partition by publication_id order by at) as until from hourly),
      ticks as (select generate_series(date_trunc('hour',now()-${q.days}*interval '1 day'),date_trunc('hour',now()),interval '1 hour') as at union select now())
      select t.at,'all' as id,'Все выбранные Shorts' as title,sum(r.views)::float as views,
        sum(r.likes)::float as likes,sum(r.comments)::float as comments,count(r.views)::int as measured
      from ticks t join ranges r on r.at<=t.at and r.until>t.at
      group by t.at order by t.at`);
    const breakdown=await this.db.execute(sql`select c.streamer,s.display_name as name,s.avatar,c.game,g.title as "gameTitle",
      count(*)::int as videos,sum(m.views)::text as views,sum(m.likes)::text as likes,sum(m.comments)::text as comments
      ${joins} ${latest} where ${where(q)} group by c.streamer,s.display_name,s.avatar,c.game,g.title order by sum(m.views) desc nulls last`);
    const [sync]=await this.db.execute(sql`select value,updated_at as "updatedAt" from platform_runtime where key='metrics'`);
    const [feedback]=await this.db.execute(sql`select value,updated_at as "updatedAt" from platform_runtime where key like 'feedback:%'
      ${q.streamer?sql`and value->>'streamer'=${q.streamer}`:sql``} order by updated_at desc limit 1`);
    return {summary,series,aggregate,breakdown,sync,feedback,feedbackAllowed:await youtubeDerivedMetricsAllowed(this.db),days:q.days};
  }
}
