import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureAdProfile} from '../dist/ad-protection.js';

for(const bounded of [false,true])test(`ad profile ${bounded?'prefix stays local':'full VOD persists'}`,async()=>{
  const cached={signature:'full-broadcast'};
  const profile={signature:'current-source',samples:12,regions:[]};
  let writes=0,params;
  const ctx={db:{select:()=>({from:()=>({where:async()=>[{adProtection:cached}]})}),
    update:()=>({set:()=>({where:async()=>{writes++;}})})},
    python:{call:async(_op,value)=>{params=value;return profile;}}};
  assert.equal(await ensureAdProfile(ctx,'v1','cache/preview/video.mp4',
    {log:()=>{},cancelled:async()=>false},bounded),profile);
  assert.equal(writes,bounded?0:1);
  assert.equal(params.cached,bounded?null:cached);
});
