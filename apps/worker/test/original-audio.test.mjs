import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {restoreAudio} from '../dist/restore-audio.js';
const ff=(args,bin='ffmpeg')=>execFileSync(bin,args,{windowsHide:true,encoding:'utf8'});
test('original audio restoration preserves the video and keeps sound between speech spans',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'clipforge-original-'));
  try{
    const cache=join(dir,'data','games','unknown','fixture','v900000001');await mkdir(cache,{recursive:true});
    const audio=join(cache,'audio.m4a'),source=join(dir,'source.mp4');
    ff(['-v','error','-y','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','12','-c:a','aac',audio]);
    ff(['-v','error','-y','-f','lavfi','-i','color=purple:size=270x480:rate=10','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','4','-c:v','libx264','-threads','1','-c:a','aac',source]);
    let output,saved,workingFile;
    const remote={call:async(op,input)=>{
      if(op==='vod.get')return {id:'v900000001',game:null,streamer:'fixture'};
      if(op==='clip.get')return input.id==='source'?{clip:{id:'source',start:2,end:6,state:'draft'},run:{}}:{clip:null};
      if(op==='original-audio.save'){saved=input;return {};}
      throw Error(op);
    },downloadClip:async(_,file)=>copyFile(source,file),uploadClip:async(_,file)=>{workingFile=file;output=join(dir,'stored.mp4');await copyFile(file,output);return {};}};
    const ctx={remote,config:{data:join(dir,'data'),out:join(dir,'out'),workerRoot:dir,videoFormat:'720p60'}};
    const result=await restoreAudio(ctx,{vodId:'v900000001',clipIds:['source']},{log:()=>{},cancelled:async()=>false});
    assert.equal(result.clips,1);assert.equal(result.audioMode,'original');assert(saved&&output);
    await assert.rejects(stat(workingFile),{code:'ENOENT'},'Committed media must not remain in the worker cache');
    const videoHash=file=>ff(['-v','error','-i',file,'-map','0:v:0','-c','copy','-f','hash','-hash','sha256','-']).trim();
    assert.equal(videoHash(output),videoHash(source));
    const pcm=execFileSync('ffmpeg',['-v','error','-ss','1','-i',output,'-t','2','-map','0:a:0','-f','f32le','-'],{windowsHide:true});
    let energy=0;for(let i=0;i<pcm.length;i+=4)energy+=pcm.readFloatLE(i)**2;
    assert(Math.sqrt(energy/(pcm.length/4))>.02,'Original background/game sound must remain audible in the gap');
    const probe=JSON.parse(ff(['-v','error','-show_entries','stream=codec_type,duration','-of','json',output],'ffprobe'));
    assert(probe.streams.every(s=>Math.abs(Number(s.duration)-4)<.1));
  }finally{await rm(dir,{recursive:true,force:true});}
});
