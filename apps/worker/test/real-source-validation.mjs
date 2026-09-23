/** Real source validation: automatic moment selection + the production renderer.
 * No forced face/no-face switch, no handpicked candidate and no publication.
 * Reuses cached Twitch source material to avoid downloading entire VODs again.
 */
import {createContext} from '../dist/context.js';
import {renderRun} from '../dist/handlers.js';
import {readSignals} from '../../../packages/pipeline/dist/index.js';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const ctx=createContext();
try {
  const [mode]=await ctx.db.sql`select value from platform_runtime where key='settings'`;
  if(!mode?.value.developmentMode)throw new Error('Validation requires development mode');
  const report={log:message=>console.log(message),cancelled:async()=>false};
  const results=[];
  const inputs=[['sany_jeweler','v2859643784'],['rostikfacekid','v2874996172'],['just_ns','v2881066789'],['recrent','v2881047555']];
  for(const [channel,vodId] of inputs) {
    if(process.argv[2] && process.argv[2]!==channel)continue;
    console.log(`Starting ${channel}`);
    let prepared;
    if(channel==='just_ns'||channel==='recrent') {
      const dir=resolve('data/reviews',channel);
      const info=JSON.parse(await readFile(join(dir,'source.json'),'utf8'));
      const transcript=JSON.parse(await readFile(join(dir,'transcript.json'),'utf8'));
      const signalMeta=await ctx.python.call('audioSignals',{audio:join(dir,'audio.wav'),out:join(dir,'signals.f32')});
      prepared={video:join(dir,'source.mp4'),transcript:{...transcript,model:ctx.config.speechModel},
        signals:await readSignals(signalMeta.file,signalMeta),offsetSeconds:info.start};
      console.log(`Automatic selection within real source ${info.start}–${info.start+info.duration}s`);
    }
    const result=await renderRun(ctx,{vodId,count:1},report,prepared);
    results.push({channel,...result});
    await writeFile('data/reviews/real-attempts.json',JSON.stringify(results,null,2));
    console.log(JSON.stringify(results.at(-1)));
  }
}finally{await ctx.close();}
