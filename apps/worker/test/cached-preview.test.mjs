import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Workspace,runMediaCommand} from '@clipforge/pipeline';
import {cachedPreview} from '../dist/cached-preview.js';

test('a native partial becomes an isolated, resumable preview with aligned audio',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cf-preview-'));
  try {
    const workspace=await new Workspace({data:root,out:join(root,'out')},
      {game:'test',streamer:'test',vodId:'v1'}).prepare();
    const pending=workspace.video('720p60').replace('.mp4','.pending.mp4');
    const partial=`${pending}.part`;
    const result=await runMediaCommand('ffmpeg',['-v','error','-y','-f','lavfi','-i',
      'color=c=black:s=64x64:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
      '-t','12','-c:v','libx264','-threads','1','-c:a','aac','-output_ts_offset','64','-f','mpegts',partial],30_000);
    assert.equal(result.code,0,result.stderr);
    const initial=await stat(partial);
    assert.equal(await cachedPreview(workspace,'720p60',5),null,'requires native checkpoint');
    await writeFile(`${pending}.ytdl`,JSON.stringify({downloader:{current_fragment:{index:1}}}));
    assert.equal(await cachedPreview(workspace,'720p60',30),null,'requires enough complete media');
    await writeFile(workspace.audio,'full audio sentinel');
    const preview=await cachedPreview(workspace,'720p60',5);
    assert.ok(preview);
    assert.equal(await readFile(workspace.audio,'utf8'),'full audio sentinel');
    assert.equal((await stat(partial)).size,initial.size);
    assert.equal(await stat(workspace.video('720p60')).catch(()=>null),null,'does not mark full VOD ready');
    const probe=JSON.parse((await runMediaCommand('ffprobe',['-v','error','-show_entries',
      'stream=codec_type,start_time,duration','-of','json',preview.video],30_000)).stdout);
    assert.ok(probe.streams.every(s=>Number(s.start_time)<.3),'Twitch PTS is rebased');
    const mtime=(await stat(preview.audio)).mtimeMs;
    assert.deepEqual(await cachedPreview(workspace,'720p60',5),preview);
    assert.equal((await stat(preview.audio)).mtimeMs,mtime,'ASR checkpoint input remains stable');
    await writeFile(workspace.video('720p60'),'full video sentinel');
    assert.equal(await cachedPreview(workspace,'720p60',5),null,'full VOD takes priority');
  } finally {await rm(root,{recursive:true,force:true});}
});
