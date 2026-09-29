import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformsService } from '../dist/platforms/platforms.service.js';

test('legacy ready clips cannot enqueue a new publication before media review',async()=>{
  const chain={from(){return this},innerJoin(){return this},where:async()=>[{id:'clip',state:'ready',archivedAt:null,reviewedAt:null}]};
  const service=new PlatformsService({select:()=>chain},{},{enqueue:()=>assert.fail('must not enqueue')});
  service.check=()=>assert.fail('must not contact Google before review');
  await assert.rejects(service.publish('clip',{accountId:'account',title:'Test',description:'',privacy:'private'}),/обработка рекламы|обработк[аи] реклам/);
});
