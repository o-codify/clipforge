import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderCount,disjointMoments} from '../dist/render-options.js';

test('explicit bounded test batch, ordinary development cap retained',()=>{
  assert.equal(renderCount({count:10},true,50),1);
  assert.equal(renderCount({count:10,testBatch:true},true,50),10);
  assert.equal(renderCount({},false,50),50);
  for(const count of [0,21,1.5])assert.throws(()=>renderCount({count,testBatch:true},true,50));
});
test('score order preserved; parallel candidates cannot overlap even at outro',()=>{
  const candidates=[{start:40,end:70},{start:60,end:90},{start:0,end:36},{start:72,end:95},{start:100,end:130}];
  assert.deepEqual(disjointMoments(candidates),[candidates[0],candidates[2],candidates[4]]);
});
