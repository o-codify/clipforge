import test from 'node:test';
import assert from 'node:assert/strict';
import {gameWindows,insideGame} from '../dist/game-selection.js';
const chapters=[{title:'WARDOGS',start:0,end:5170},{title:'Dota 2',start:5170,end:11155}];
test('selects only the requested game and rejects a clip crossing the game transition',()=>{
  assert.deepEqual(gameWindows(chapters,'wardogs'),[chapters[0]]);
  assert.equal(insideGame(chapters,'wardogs',100,150),true);
  assert.equal(insideGame(chapters,'wardogs',5160,5180),false);
  assert.equal(insideGame(chapters,'wardogs',5500,5530),false);
  assert.equal(insideGame(chapters,'dota_2',5500,5530),true);
  assert.deepEqual(gameWindows(chapters,'unknown'),[]);
});
