import {Controller,Get,Post,Body,Param,Query,Inject,NotFoundException} from '@nestjs/common';
import {sql} from 'drizzle-orm';
import {type Database} from '@clipforge/db';
import {z} from 'zod';
import {DATABASE} from './config.js';
import {AdminOnly} from './auth/auth.guard.js';
import {WorkerGatewayService} from './worker-gateway.service.js';
const tasks=sql`(select id,name,state::text,data,created_on,started_on,completed_on,output from jobs.job
  union all select id,name,state,'{}'::jsonb,started_at,started_at,completed_at,output from automation_runs)`;
@Controller('api/workers')
@AdminOnly()
export class WorkersController {
  constructor(@Inject(DATABASE) private readonly db:Database,private readonly gateway:WorkerGatewayService){}
  @Post('connect') connect(@Body() body:unknown){return this.gateway.connect(body);}
  @Post(':id/revoke') revoke(@Param('id') id:string){return this.gateway.revoke(id);}
  @Get()
  async list(){
    const rows=await this.db.execute(sql`select w.id,w.label,w.host,w.role,w.queues,w.resources,w.draining,w.version,
      exists(select 1 from remote_worker_auth a where a.worker_id=w.id) as remote,
      w.started_at as "startedAt",w.heartbeat_at as "heartbeatAt",
      case when w.state='revoked' then 'revoked' when w.heartbeat_at<now()-interval '40 seconds' then 'offline' else w.state end as state,
      coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'name',j.name,'stage',x.stage,
        'startedAt',x.started_at,'streamer',coalesce(j.data->>'login',v.streamer,c.streamer),'vodId',coalesce(j.data->>'vodId',c.vod_id)))
        from worker_jobs x join ${tasks} j on j.id=x.job_id
        left join vods v on v.id=j.data->>'vodId'
        left join publications p on p.id=j.data->>'publicationId' left join clips c on c.id=coalesce(p.clip_id,j.data->>'clipId')
        where x.worker_id=w.id and x.finished_at is null and j.state='active'),'[]'::jsonb) as active
      from worker_instances w order by lower(w.label),w.id`);
    // Existing processes remain visible during a rolling upgrade, but cannot be controlled as new workers.
    const legacy=await this.db.execute<{key:string;value:Record<string,unknown>;heartbeatAt:Date}>(sql`select key,value,updated_at as "heartbeatAt" from platform_runtime
      where key in ('worker','control') and updated_at>now()-interval '40 seconds' and value->>'state'='online' and value->>'workerId' is null`);
    const byName=new Intl.Collator('ru',{numeric:true,sensitivity:'base'});
    return [...rows,...legacy.map(r=>({id:'legacy:'+r.key,label:r.key==='control'?'Контроллер платформы':'Компьютер обработки',role:r.value.role,
      resources:r.value.resources,state:'online',heartbeatAt:r.heartbeatAt,active:[],legacy:true}))]
      .sort((a,b)=>byName.compare(String(a.label),String(b.label))||String(a.id).localeCompare(String(b.id)));
  }
  @Post(':id/drain')
  async drain(@Param('id') id:string,@Body() body:unknown){
    const {draining}=z.object({draining:z.boolean()}).parse(body);
    const rows=await this.db.execute(sql`update worker_instances set draining=${draining} where id=${z.string().max(128).parse(id)} returning id`);
    if(!rows.length)throw new NotFoundException('Воркер не найден');return {draining};
  }
  @Get('jobs')
  async jobs(@Query() raw:unknown){
    const q=z.object({worker:z.string().max(128).optional(),state:z.enum(['active','waiting','completed','failed']).optional(),page:z.coerce.number().int().min(1).max(10000).default(1)}).parse(raw);
    const rows=await this.db.execute(sql`select j.id::text,j.name,j.state,j.created_on as "createdAt",j.started_on as "startedAt",j.completed_on as "completedAt",
      x.worker_id as "workerId",w.label as "workerName",x.stage,j.output,
      coalesce(j.data->>'login',v.streamer,c.streamer) as streamer,s.display_name as "streamerName",s.avatar,
      coalesce(j.data->>'vodId',c.vod_id) as "vodId",count(*) over()::int as total
      from ${tasks} j left join worker_jobs x on x.job_id=j.id left join worker_instances w on w.id=x.worker_id
      left join publications p on p.id=j.data->>'publicationId' left join clips c on c.id=coalesce(p.clip_id,j.data->>'clipId')
      left join vods v on v.id=j.data->>'vodId' left join streamers s on s.login=coalesce(j.data->>'login',v.streamer,c.streamer)
      where true ${q.worker?sql`and x.worker_id=${q.worker}`:sql``}
      ${q.state==='waiting'?sql`and j.state in ('created','retry')`:q.state?sql`and j.state=${q.state}`:sql``}
      order by (j.state='active') desc,j.created_on desc,j.id limit 50 offset ${(q.page-1)*50}`);
    return {rows,total:Number(rows[0]?.total??0),page:q.page,hasMore:Number(rows[0]?.total??0)>q.page*50};
  }
}
