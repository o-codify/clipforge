import {Controller,Get,Post,Inject} from '@nestjs/common';
import {sql} from 'drizzle-orm';
import {runtimeValue,type Database} from '@clipforge/db';
import {cloudUploadQuota,quotaDay} from '@clipforge/youtube';
import {DATABASE} from './config.js';
import {AdminOnly} from './auth/auth.guard.js';
@Controller('api/publication-process')
@AdminOnly()
export class PublicationProcessController {
  private checking:Promise<unknown>|null=null;
  constructor(@Inject(DATABASE) private readonly db:Database){}
  @Post('quota')
  checkQuota(){
    this.checking??=cloudUploadQuota().then(async value=>{await runtimeValue(this.db,'youtube-quota',value);return value;}).finally(()=>{this.checking=null;});
    return this.checking;
  }
  @Get()
  async status(){
    const window=quotaDay();
    const [quota]=await this.db.execute(sql`select value,updated_at as "updatedAt" from platform_runtime where key='youtube-quota'`);
    const channels=await this.db.execute(sql`select a.external_id as id,a.label,
      count(p.id) filter(where p.created_at>=${window.start}::timestamptz)::int as "attemptsToday",
      count(p.id) filter(where p.created_at>=${window.start}::timestamptz and p.media_id is not null)::int as "uploadedToday",
      count(p.id) filter(where p.created_at>now()-interval '24 hours')::int as "attempts24h",b.value as restriction
      from platform_accounts a left join publications p on p.account=a.external_id and p.platform='youtube'
      left join platform_runtime b on b.key='youtube-upload-block:'||a.external_id
      where a.platform='youtube' and a.disconnect_requested_at is null group by a.external_id,a.label,b.value`);
    const uploads=await this.db.execute(sql`select p.id,p.title,p.status,p.error,p.privacy,p.media_id as "videoId",p.created_at as "createdAt",p.updated_at as "updatedAt",
      c.streamer,s.display_name as "streamerName",s.avatar,a.label as channel,progress.value as progress
      from publications p join clips c on c.id=p.clip_id join streamers s on s.login=c.streamer
      join platform_accounts a on a.external_id=p.account and a.platform=p.platform
      left join platform_runtime progress on progress.key='upload-progress:'||p.id
      where p.platform='youtube' and a.disconnect_requested_at is null and p.status in ('queued','uploading','processing','failed')
      order by case when p.status='failed' then 1 else 0 end,p.created_at desc limit 50`);
    return {quota:quota?.value??null,channels,uploads,...window,serverTime:new Date().toISOString()};
  }
}
