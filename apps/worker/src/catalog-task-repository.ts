import {and,eq,sql} from 'drizzle-orm';
import {type Database,streamers,vods,games} from '@clipforge/db';
import {z} from 'zod';
import {safeName} from '@clipforge/pipeline';
import type {MediaTaskScope} from './media-task-repository.js';

export class CatalogTaskRepository {
  constructor(private readonly db:Database,private readonly scope:MediaTaskScope){}
  async call(operation:string,input:unknown){
    if(this.scope.queue!=='light.index-channel')throw new Error('Недоступная операция');
    const login=z.string().regex(/^[a-zA-Z0-9_]{1,64}$/).parse(this.scope.payload.login).toLowerCase();
    if(!(await this.db.select({login:streamers.login}).from(streamers).where(eq(streamers.login,login))).length)throw new Error('Канал задания не найден');
    if(operation==='catalog.known')return this.db.select({id:vods.id}).from(vods).where(eq(vods.streamer,login));
    if(operation==='catalog.save'){
      const m=z.object({id:z.string().regex(/^v[0-9]+$/),login:z.literal(login),title:z.string().max(2000),duration:z.number().min(0).max(604800),
        publishedAt:z.string().datetime().nullable(),game:z.string().max(200),chapters:z.array(z.object({title:z.string().max(200),start:z.number().nonnegative(),end:z.number().nonnegative()})).max(1000)}).strict().parse(input);
      const [existing]=await this.db.select({streamer:vods.streamer}).from(vods).where(eq(vods.id,m.id));
      if(existing&&existing.streamer!==login)throw new Error('Эфир относится к другому каналу');
      const game=m.game.trim()?safeName(m.game):null;
      if(game==='.'||game==='..')throw new Error('Некорректная игра');
      if(game)await this.db.insert(games).values({slug:game,title:m.game}).onConflictDoNothing();
      const value={title:m.title,duration:m.duration,publishedAt:m.publishedAt?new Date(m.publishedAt):null,chapters:m.chapters,...(game?{game}:{})};
      await this.db.insert(vods).values({...value,id:m.id,streamer:login,state:'known'}).onConflictDoUpdate({target:vods.id,set:value,setWhere:eq(vods.streamer,login)});
      return {added:!existing};
    }
    if(operation==='catalog.finish'){
      await this.db.update(streamers).set({indexedAt:new Date()}).where(eq(streamers.login,login));
      await this.db.execute(sql`insert into streamer_games(streamer,game,seconds,streams,last_seen)
        select streamer,game,sum(coalesce(duration,0)),count(*)::int,now() from vods where streamer=${login} and game is not null group by streamer,game
        on conflict(streamer,game) do update set seconds=excluded.seconds,streams=excluded.streams,last_seen=excluded.last_seen`);
      return {};
    }
    throw new Error('Операция каталога не разрешена');
  }
}
