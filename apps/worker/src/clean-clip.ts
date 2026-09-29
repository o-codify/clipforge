import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { clips, runs, vods, streamers, transcripts } from '@clipforge/db';
import { newRunId, probeMedia, Workspace, computeGrid, renderClip, defaultStyle, headerLockup, outroCard, allWords, findProfanity, mergeSpans, beepSpans } from '@clipforge/pipeline';
import type { PayloadOf, QUEUES } from '@clipforge/jobs';
import type { Context } from './context.js';
import type { JobReport } from './handlers.js';
import { storeClip } from './media-storage.js';
import {ensureAdProfile} from './ad-protection.js';
import {fetchVod} from './handlers.js';

/** Immutable replacement: existing files, publications and originals survive. */
export async function cleanClip(ctx:Context, payload:PayloadOf<typeof QUEUES.cleanClip>, report:JobReport) {
  if(!payload.regions.length)return rebuildProtectedClip(ctx,payload,report);
  let [row] = await ctx.db.select({clip:clips,run:runs}).from(clips).innerJoin(runs,eq(runs.id,clips.runId)).where(eq(clips.id,payload.clipId));
  if (!row || row.clip.archivedAt || row.clip.vodId !== payload.vodId) throw new Error('Клип не найден');
  // Rebuild from the original, including when opening an old audio-cleaned
  // version. Ad masking must preserve the original mix and prior manual masks.
  const inherited=row.run.settings.cleanupRegions as PayloadOf<typeof QUEUES.cleanClip>['regions']|undefined;
  const regions=[...(inherited ?? []),...payload.regions];
  if(regions.length>32)throw new Error('Для одного клипа можно закрыть не больше 32 областей');
  const originalId=row.run.settings.sourceClipId;
  if(typeof originalId==='string') {
    const [original]=await ctx.db.select({clip:clips,run:runs}).from(clips).innerJoin(runs,eq(runs.id,clips.runId)).where(eq(clips.id,originalId));
    if(!original || original.clip.vodId!==payload.vodId)throw new Error('Исходная версия клипа недоступна');
    row=original;
  }
  const hash = createHash('sha256').update(JSON.stringify({v:2,parent:row.clip.id,method:'original',regions})).digest('hex').slice(0,12);
  const id = `${row.clip.id}_clean_${hash}`;
  const [existing] = await ctx.db.select({id:clips.id}).from(clips).where(eq(clips.id,id));
  if (existing) return {clipId:id};
  const outDir = join(ctx.config.out,'cleaned',hash);
  await mkdir(outDir,{recursive:true});
  let source = join(row.run.outDir,row.clip.file);
  if (!await stat(source).then(s=>s.size>0).catch(()=>false)) {
    if (!ctx.storage || !row.clip.mediaStorage) throw new Error('Исходный клип недоступен');
    source=join(outDir,'source.mp4');
    await ctx.storage.downloadFile(row.clip.mediaStorage.videoKey,source);
  }
  report.log('Проверяю QR-коды и рекламные баннеры');
  const duration = (await probeMedia(source))?.duration;
  if (!duration || !Number.isFinite(duration)) throw new Error('Не удалось определить длительность клипа');
  const file=join(outDir,'clip.mp4');
  const protection=await ctx.python.call('cleanClip',{video:source,start:0,end:duration,out:file,
    regions,transcript:row.clip.text ?? ''});
  if (await report.cancelled()) return {cancelled:true};
  const mediaStorage=await storeClip(ctx,id,file);
  const runId=newRunId(new Date());
  await ctx.db.transaction(async db=>{
    await db.insert(runs).values({id:runId,vodId:row.clip.vodId,streamer:row.clip.streamer,game:row.clip.game,
      outDir,version:hash,candidates:1,finishedAt:new Date(),settings:{sourceClipId:row.clip.id,cleanupRegions:regions,renderedClips:{[id]:{protection}},selection:'cleanup'}});
    const {createdAt,archivedAt,archiveReason,...copy}=row.clip;
    await db.insert(clips).values({...copy,id,runId,version:hash,file:'clip.mp4',mediaStorage,
      sizeBytes:(await stat(file)).size,state:'draft',blockedReason:null});
  });
  report.log('Новая версия готова. Проверьте скрытие рекламы перед публикацией');
  return {clipId:id,sourceClipId:row.clip.id};
}

/** Re-render old versions from the VOD, so masks also cover cropped/blurred copies. */
async function rebuildProtectedClip(ctx:Context,payload:PayloadOf<typeof QUEUES.cleanClip>,report:JobReport) {
  const [row]=await ctx.db.select({clip:clips,run:runs}).from(clips).innerJoin(runs,eq(runs.id,clips.runId)).where(eq(clips.id,payload.clipId));
  if(!row||row.clip.archivedAt||row.clip.vodId!==payload.vodId||row.clip.state==='blocked')throw new Error('Клип недоступен для обработки');
  const [vod]=await ctx.db.select().from(vods).where(eq(vods.id,payload.vodId));
  if(!vod||row.clip.start===null||row.clip.end===null)throw new Error('Границы исходного момента недоступны');
  const workspace=new Workspace({data:ctx.config.data,out:ctx.config.out},{game:vod.game??'unknown',streamer:vod.streamer,vodId:vod.id});
  await workspace.prepare();
  const video=workspace.video(ctx.config.videoFormat);
  if(!await stat(video).then(s=>s.size>0).catch(()=>false))await fetchVod(ctx,{vodId:vod.id,audioOnly:false},report);
  const profile=await ensureAdProfile(ctx,vod.id,video,report);
  const previous=(row.run.settings.renderedClips as Record<string,{grid?:ReturnType<typeof computeGrid>;protection?:{audio?:{method?:string}}}>|undefined)?.[row.clip.id];
  const audioMode=previous?.protection?.audio?.method??row.run.settings.audioMode??'original';
  if(!['original','dtln'].includes(String(audioMode)))throw new Error('Настройка звука исходного клипа недоступна');
  const hash=createHash('sha256').update(JSON.stringify({v:3,parent:row.clip.id,profile:profile.signature,audioMode})).digest('hex').slice(0,12);
  const id=`${row.clip.id}_ads_${hash}`;
  const [existing]=await ctx.db.select({id:clips.id}).from(clips).where(eq(clips.id,id));
  if(existing)return {clipId:id};
  const [transcript]=await ctx.db.select().from(transcripts).where(eq(transcripts.vodId,vod.id));
  if(!transcript)throw new Error('Расшифровка исходного эфира недоступна');
  let grid=previous?.grid;
  if(!grid){
    const camera=await ctx.python.call('facecam',{video,modelPath:join(ctx.config.models,'face_detection_yunet_2023mar.onnx'),start:row.clip.start,end:row.clip.end,samples:40});
    if(vod.facecam?.found&&!camera.found)throw new Error('Камера исходного момента не подтверждена');
    const map=await ctx.python.call('minimap',{video,game:row.clip.game??'',start:row.clip.start,end:row.clip.end,samples:12,...(camera.rect?{excludeRect:camera.rect}:{})});
    grid=computeGrid(profile.width,profile.height,camera.rect,{minimapRect:map.rect});
  }
  const outDir=join(ctx.config.out,'protected',hash);
  await mkdir(outDir,{recursive:true});
  const file=join(outDir,'clip.mp4');
  const protection=await ctx.python.call('prepareMedia',{video,start:row.clip.start,end:row.clip.end+3.4,
    transcript:row.clip.text??'',adProfile:profile,
    ...(audioMode==='dtln'?{audioMode,models:ctx.config.models,audioOut:join(outDir,'dtln.wav')}:{})});
  if(protection.ads.reject)throw new Error(protection.ads.reason??'Рекламный фрагмент пропущен');
  const [streamer]=await ctx.db.select({displayName:streamers.displayName}).from(streamers).where(eq(streamers.login,vod.streamer));
  const channel=streamer?.displayName??vod.streamer;
  const style=defaultStyle({size:66,topY:grid.subTop,maxPhraseSeconds:3.2,maxPhraseChars:42,censor:true,maxLineWidth:992});
  const spans=mergeSpans(beepSpans(findProfanity(allWords(transcript)).filter(h=>h.end>row.clip.start!&&h.start<row.clip.end!)));
  const result=await renderClip({source:video,start:row.clip.start,end:row.clip.end,out:file,grid,
    assets:{root:ctx.config.assets},transcript,style,censorSpans:spans,censorBeep:false,
    header:headerLockup({channel}),outro:outroCard({channel,url:`twitch.tv/${vod.streamer}`,seconds:3.4}),
    sourceMasks:protection.ads.regions,audioSource:protection.audio.method==='dtln'?protection.audio.file:undefined,
    crf:20,preset:'veryfast',fps:30,audioBitrate:'160k',threads:2});
  if(!result.ok)throw new Error(result.error);
  if(await report.cancelled())return {cancelled:true};
  const storage=await storeClip(ctx,id,file),runId=newRunId(new Date());
  const proof={...protection,autoVerifiedAt:new Date().toISOString()};
  await ctx.db.transaction(async db=>{
    await db.insert(runs).values({id:runId,vodId:vod.id,streamer:vod.streamer,game:vod.game,outDir,version:hash,
      candidates:1,finishedAt:new Date(),settings:{sourceClipId:row.clip.id,selection:'ad-protection',audioMode,
        testBatch:row.run.settings.testBatch??false,renderedClips:{[id]:{grid,protection:proof}}}});
    const {createdAt,archivedAt,archiveReason,...copy}=row.clip;
    await db.insert(clips).values({...copy,id,runId,version:hash,file:'clip.mp4',mediaStorage:storage,
      sizeBytes:(await stat(file)).size,state:row.run.settings.testBatch?'draft':'ready',blockedReason:null});
  });
  report.log('Клип обработан по карте эфира. Ручная проверка рекламы не требуется');
  return {clipId:id,sourceClipId:row.clip.id};
}
