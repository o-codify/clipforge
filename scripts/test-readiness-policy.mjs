import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readinessExpired} from './readiness-policy.mjs';
test('brief database outages do not restart the application; a persistent failure does',()=>{
  const state={startedAt:0,unreadySince:100000,wasReady:true};
  assert.equal(readinessExpired({...state,now:160000}),false);
  assert.equal(readinessExpired({...state,now:279999}),false);
  assert.equal(readinessExpired({...state,now:280000}),true);
  assert.equal(readinessExpired({...state,unreadySince:null,now:500000}),false);
});
