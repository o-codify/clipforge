import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishClip } from '../dist/publish.js';

test('worker independently rejects an unreviewed clip even if a publication was queued',async()=>{
  const row={publication:{id:'publication',status:'queued'},state:'ready',archivedAt:null,reviewedAt:null};
  const query={from(){return this},innerJoin(){return this},leftJoin(){return this},where:async()=>[row]};
  let saved;
  const ctx={youtube:{clientId:'offline',clientSecret:'offline'},db:{
    select:()=>query,execute:async()=>[],update:()=>({set:values=>{saved=values;return {where:async()=>{}}}})
  }};
  await assert.rejects(publishClip(ctx,{publicationId:'publication'},{log:()=>{}}),/обработка рекламы|обработк[аи] реклам/);
  assert.equal(saved.status,'failed');
});
