import {and,eq,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import {clips,games,runs,streamers,transcripts,vods,vodAudioSettings,vodAdSettings} from '@clipforge/db';
import {adProfileSchema,audioSignalsResultSchema,rectSchema,transcribeResultSchema} from '@clipforge/contracts';
import {safeName,segmentKey,clipId,type Candidate} from '@clipforge/pipeline';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {Context} from './context.js';
import {applyFeedback} from './feedback.js';
import {insideGame,gameSlug} from './game-selection.js';

export type MediaTaskScope={jobId:string;leaseId:string;queue:string;vodId:string;payload:Record<string,unknown>};
const id=z.string().regex(/^[a-zA-Z0-9_.:-]{1,220}$/);
const number=z.number().finite();
const second=number.min(0).max(7*86400);
const object=z.record(z.unknown());
const filename=z.string().min(1).max(240).refine(s=>!/[\\/\x00]/.test(s)&&s!=='.'&&s!=='..');
const range=z.object({start:second,end:second}).refine(r=>r.end>r.start);
const clipSchema=z.object({id,runId:id,vodId:id,streamer:id,game:z.string().max(200).nullable(),segmentKey:id,version:id,
  file:filename,mediaStorage:z.unknown(),state:z.enum(['draft','ready']),trigger:z.string().max(200),peak:second,start:second,end:second,
  duration:number.positive().max(180),score:number,parts:z.record(number),keywords:z.array(z.string().max(200)).max(100),text:z.string().max(30000).optional(),
  width:z.number().int().positive().max(4096),height:z.number().int().positive().max(4096),fps:number.positive().max(120),sizeBytes:z.number().int().positive().max(1024**3)});

/** Explicit media operations. The HTTP caller never chooses a table, SQL query,
 * VOD, streamer, storage key, publication or platform credential. The gateway
 * validates the live lease and holds its row lock for this entire transaction. */
export class MediaTaskRepository {
  constructor(private readonly ctx:Pick<Context,'db'>&{config:{out:string}},private readonly scope:MediaTaskScope){}
  private async vod(){const [v]=await this.ctx.db.select().from(vods).where(eq(vods.id,this.scope.vodId));if(!v)throw new Error('Эфир задания не найден');return v;}
  private reportId(){return String(this.scope.payload.batchId??this.scope.jobId);}
  private async run(runId:string){const [r]=await this.ctx.db.select().from(runs).where(and(eq(runs.id,id.parse(runId)),eq(runs.vodId,this.scope.vodId)));
    if(!r||r.settings.jobId!==this.reportId())throw new Error('Прогон не принадлежит заданию');return r;}
  async clip(clipId:string){const [c]=await this.ctx.db.select().from(clips).where(and(eq(clips.id,id.parse(clipId)),eq(clips.vodId,this.scope.vodId)));
    if(!c)return {clip:null,run:null};const [r]=await this.ctx.db.select().from(runs).where(eq(runs.id,c.runId));return {clip:c,run:r??null};}
  private async assets(clipId:string){const rows=await this.ctx.db.execute<{kind:string;storageKey:string}>(sql`select kind,storage_key as "storageKey" from remote_worker_uploads
    where lease_id=${this.scope.leaseId}::uuid and clip_id=${clipId} and state='stored'`);
    const videoKey=rows.find(r=>r.kind==='video')?.storageKey,posterKey=rows.find(r=>r.kind==='poster')?.storageKey;
    if(!videoKey||!posterKey)throw new Error('Файлы клипа ещё не приняты платформой');return {videoKey,posterKey};}
  private async unblocked(start:number,end:number){const [blocked]=await this.ctx.db.select({id:clips.id}).from(clips).where(and(eq(clips.vodId,this.scope.vodId),
    eq(clips.state,'blocked'),sql`${clips.start}<${end} and ${clips.end}>${start}`)).limit(1);return blocked??null;}
  async call(operation:string,raw:unknown):Promise<unknown>{
    const rendering=['heavy.pipeline','heavy.prepare-preview','heavy.prepare-batch-vod','heavy.render-run','heavy.render-variant'].includes(this.scope.queue);
    if((operation.startsWith('render.')||['clip.save','clip.supersede','selection.feedback'].includes(operation))&&!rendering)throw new Error('Операция недоступна для этого задания');
    const db=this.ctx.db,v=await this.vod(),input=raw??{};
    switch(operation){
      case 'vod.get': return v;
      case 'game.ensure': {const {title}=z.object({title:z.string().max(200)}).parse(input);const clean=title.trim();if(!clean)return null;
        const slug=safeName(clean);if(slug==='.'||slug==='..')throw new Error('Неверное название игры');await db.insert(games).values({slug,title:clean}).onConflictDoNothing();return slug;}
      case 'vod.metadata': {const m=z.object({title:z.string().max(2000),duration:second,game:z.string().max(200).nullable(),publishedAt:z.string().nullable().optional(),
        chapters:z.array(z.object({title:z.string().max(200),start:second,end:second})).max(1000)}).parse(input);
        const date=m.publishedAt?new Date(m.publishedAt):null;if(date&&!Number.isFinite(date.getTime()))throw new Error('Неверная дата эфира');
        await db.update(vods).set({...m,publishedAt:date}).where(eq(vods.id,v.id));return {};}
      case 'vod.state': {const m=z.object({state:z.enum(['known','fetching','ready','failed']),error:z.string().max(500).optional()}).parse(input);
        await db.update(vods).set({...m,error:m.error??null,...(m.state==='ready'?{fetchedAt:new Date()}:{})}).where(eq(vods.id,v.id));return {};}
      case 'vod.signals': {const m=audioSignalsResultSchema.parse(input);await db.update(vods).set({signals:m}).where(eq(vods.id,v.id));return {};}
      case 'vod.facecam': {const m=z.object({found:z.boolean(),rect:rectSchema.nullable(),confidence:number.min(0).max(1),note:z.string().max(2000),detectorVersion:z.string().max(100)}).parse(input);
        await db.update(vods).set({facecam:m}).where(eq(vods.id,v.id));return {};}
      case 'vod.ad-profile': {const m=adProfileSchema.parse(input);await db.update(vods).set({adProtection:m}).where(eq(vods.id,v.id));return {};}
      case 'transcript.get':return (await db.select().from(transcripts).where(eq(transcripts.vodId,v.id)))[0]??null;
      case 'transcript.save': {const m=transcribeResultSchema.extend({model:z.string().max(100)}).parse(input);
        await db.insert(transcripts).values({...m,vodId:v.id}).onConflictDoUpdate({target:transcripts.vodId,set:{...m,createdAt:new Date()}});return {};}
      case 'streamer.name':return (await db.select({displayName:streamers.displayName}).from(streamers).where(eq(streamers.login,v.streamer)))[0];
      case 'selection.feedback': {const m=z.object({candidates:z.array(z.object({peak:second,start:second,end:second,score:number,parts:z.record(number),keywords:z.array(z.string()).max(100),text:z.string().optional()}).passthrough()).max(300)}).parse(input);
        return applyFeedback(this.ctx,v.streamer,m.candidates as Candidate[],v.game);}
      case 'render.snapshot': {const [resuming]=await db.select().from(runs).where(and(eq(runs.vodId,v.id),sql`${runs.settings}->>'jobId'=${this.reportId()}`)).limit(1);
        const [mode]=await db.execute<{value:{developmentMode?:boolean}}>(sql`select value from platform_runtime where key='settings'`);
        const audio=z.enum(['original','dtln','dtln-gated']).optional().parse(this.scope.payload.audioMode);
        return {resuming:resuming??null,audioSettings:await vodAudioSettings(db,v.id,audio),adsSettings:await vodAdSettings(db,v.id),developmentMode:!!mode?.value.developmentMode,
          previousClips:resuming?await db.select({id:clips.id}).from(clips).where(eq(clips.runId,resuming.id)):[],
          covered:await db.select({start:clips.start,end:clips.end}).from(clips).where(and(eq(clips.vodId,v.id),sql`(${clips.archivedAt} is null or exists(select 1 from publications p where p.clip_id=${clips.id}))`)),
          channelName:(await db.select({name:streamers.displayName}).from(streamers).where(eq(streamers.login,v.streamer)))[0]?.name??v.streamer};}
      case 'render.begin': {const m=z.object({id,candidates:z.number().int().min(0).max(10000),version:id,settings:object}).parse(input);
        const existing=await db.select().from(runs).where(eq(runs.id,m.id));if(existing.length){await this.run(m.id);return {};}
        const audio=await vodAudioSettings(db,v.id,z.enum(['original','dtln','dtln-gated']).optional().parse(this.scope.payload.audioMode)),ads=await vodAdSettings(db,v.id);
        await db.insert(runs).values({...m,vodId:v.id,streamer:v.streamer,game:v.game,outDir:join(this.ctx.config.out,'remote',v.id,m.id),
          settings:{...m.settings,jobId:this.reportId(),remoteJobId:this.scope.jobId,audioMode:audio.mode,audioSettings:audio,adsSettings:ads,
            testBatch:this.scope.payload.testBatch===true||this.scope.queue.includes('prepare-')}});return {};}
      case 'render.finish': {const m=z.object({runId:id,renderedClips:object.optional(),qualityRejected:number.int().nonnegative().optional()}).parse(input);await this.run(m.runId);
        // Clip proof was saved atomically with each accepted file. Finishing does not overwrite it.
        await db.update(runs).set({finishedAt:new Date()}).where(eq(runs.id,m.runId));return {};}
      case 'clip.get':return this.clip(z.object({id}).parse(input).id);
      case 'original-audio.save': {
        if(this.scope.queue!=='heavy.restore-audio')throw new Error('Операция недоступна');
        const m=z.object({sourceClipId:id,id,runId:id,version:id,file:filename,sizeBytes:number.int().positive().max(1024**3)}).strict().parse(input);
        if(!(this.scope.payload.clipIds as string[]).includes(m.sourceClipId))throw new Error('Клип не выбран для этого задания');
        const source=await this.clip(m.sourceClipId),c=source.clip,r=source.run;
        const version=createHash('sha256').update('original-audio-v1:'+m.sourceClipId).digest('hex').slice(0,12);
        if(!c||!r||c.state==='blocked'||c.archivedAt||m.version!==version||m.id!==c.id+'_original_'+version)throw new Error('Исходный клип недоступен');
        if((await this.clip(m.id)).clip)return {};
        const mediaStorage=await this.assets(m.id),{createdAt,archivedAt,archiveReason,...copy}=c;
        const oldProof=(r.settings.renderedClips as Record<string,Record<string,unknown>>|undefined)?.[c.id]??{};
        const oldProtection=(oldProof.protection??{}) as Record<string,unknown>;
        const proof={...oldProof,protection:{...oldProtection,audio:{method:'original',speechGated:false}}};
        await db.insert(runs).values({id:m.runId,vodId:v.id,streamer:v.streamer,game:c.game,outDir:join(this.ctx.config.out,'remote',v.id,m.runId),version,candidates:1,finishedAt:new Date(),
          settings:{...r.settings,jobId:this.reportId(),sourceClipId:c.id,selection:'original-audio',audioMode:'original',audioSettings:{mode:'original',source:'run'},testBatch:true,renderedClips:{[m.id]:proof}}});
        await db.insert(clips).values({...copy,id:m.id,runId:m.runId,version,file:m.file,sizeBytes:m.sizeBytes,mediaStorage,state:'draft',blockedReason:null});return {};
      }
      case 'clip.blocked':{const m=range.parse(input);return this.unblocked(m.start,m.end);}
      case 'clip.save': {const m=z.object({clip:clipSchema,proof:object}).parse(input),c=m.clip,r=await this.run(c.runId);
        const selectedGame=this.scope.payload.game;
        if(typeof selectedGame==='string'&&(!insideGame(v.chapters,selectedGame,c.start,c.end)||gameSlug(c.game??'')!==gameSlug(selectedGame)))throw new Error('Клип выходит за главу выбранной игры');
        if(c.vodId!==v.id||c.streamer!==v.streamer||c.end<=c.start||c.end>(v.duration??7*86400)+5||c.end-c.start>180||c.segmentKey!==segmentKey(v.id,c.start,c.end)||c.id!==clipId(v.id,c.segmentKey,c.version))throw new Error('Неверные границы или идентификатор клипа');
        if(await this.unblocked(c.start,c.end))throw new Error('Момент заблокирован');
        const [published]=await db.execute(sql`select 1 from publications where clip_id=${c.id} limit 1`);if(published)return {saved:false};
        const protection=object.parse(m.proof.protection),ads=object.parse(protection.ads),enabled=(r.settings.adsSettings as {enabled:boolean}).enabled;
        if(ads.reject===true)throw new Error('Рекламный фрагмент отклонён');
        if(r.settings.audioMode!=='original'&&object.parse(protection.audio).method!=='dtln')throw new Error('DTLN не подтверждён');
        const state=r.settings.testBatch||enabled&&!ads.automatic?'draft':'ready',mediaStorage=await this.assets(c.id);
        await db.insert(clips).values({...c,mediaStorage,state}).onConflictDoUpdate({target:clips.id,set:{runId:c.runId,file:c.file,mediaStorage,sizeBytes:c.sizeBytes,state,archivedAt:null,archiveReason:null}});
        await db.update(runs).set({settings:sql`jsonb_set(${runs.settings},'{renderedClips}',coalesce(${runs.settings}->'renderedClips','{}'::jsonb)||${JSON.stringify({[c.id]:m.proof})}::jsonb)`}).where(eq(runs.id,r.id));return {saved:true};}
      case 'clip.supersede':{const m=z.object({segment:id,version:id}).parse(input);
        const removed=await db.delete(clips).where(and(eq(clips.vodId,v.id),eq(clips.segmentKey,m.segment),isNull(clips.archivedAt),sql`${clips.version}<>${m.version} and ${clips.state}<>'blocked' and not exists(select 1 from publications p where p.clip_id=${clips.id})`)).returning({id:clips.id});return removed.length;}
      case 'cleanup.save': {if(this.scope.queue!=='heavy.clean-clip')throw new Error('Операция недоступна');
        const m=z.object({sourceClipId:id,id,runId:id,version:id,file:filename,sizeBytes:number.int().positive().max(1024**3),settings:object,state:z.enum(['draft','ready'])}).parse(input);
        const original=await this.clip(String(this.scope.payload.clipId)),source=await this.clip(m.sourceClipId);
        if(!original.clip||!source.clip||source.clip.state==='blocked'||(m.sourceClipId!==original.clip.id&&m.sourceClipId!==original.run?.settings.sourceClipId)||!m.id.startsWith(m.sourceClipId+'_'))throw new Error('Исходный клип недоступен');
        if((await this.clip(m.id)).clip)return {};
        const {createdAt,archivedAt,archiveReason,...copy}=source.clip,mediaStorage=await this.assets(m.id);
        await db.insert(runs).values({id:m.runId,vodId:v.id,streamer:v.streamer,game:source.clip.game,outDir:join(this.ctx.config.out,'remote',v.id,m.runId),version:m.version,candidates:1,finishedAt:new Date(),settings:{...m.settings,jobId:this.reportId(),sourceClipId:m.sourceClipId}});
        const rendered=m.settings.renderedClips as Record<string,{protection?:{ads?:{automatic?:boolean}}}>|undefined;
        const automatic=m.settings.selection==='ad-protection'&&rendered?.[m.id]?.protection?.ads?.automatic===true;
        await db.insert(clips).values({...copy,id:m.id,runId:m.runId,version:m.version,file:m.file,sizeBytes:m.sizeBytes,mediaStorage,state:automatic&&!source.run?.settings.testBatch?'ready':'draft',blockedReason:null});return {};}
      default:throw new Error('Операция воркера не разрешена');
    }
  }
}
