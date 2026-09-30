import {test} from 'node:test';
import assert from 'node:assert/strict';
import {speechHeadroomMb} from '../dist/worker-client.js';

test('cold speech model waits for allocation headroom; warm model does not reserve twice',()=>{
  assert.equal(speechHeadroomMb('large-v3'),4096);
  assert.equal(speechHeadroomMb('large-v3','large-v3'),256);
  assert.equal(speechHeadroomMb('large-v3','small'),4096);
  assert.equal(speechHeadroomMb('mobiuslabsgmbh/faster-whisper-large-v3-turbo'),2304);
  assert.equal(speechHeadroomMb('base'),768);
});
