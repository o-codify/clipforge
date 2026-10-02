import test from 'node:test';
import assert from 'node:assert/strict';
import {gameWindows,insideGame,selectedGameWindow} from '../dist/game-selection.js';
const chapters=[{title:'WARDOGS',start:0,end:5170},{title:'Dota 2',start:5170,end:11155}];
test('selects only the requested game and rejects a clip crossing the game transition',()=>{
  assert.deepEqual(gameWindows(chapters,'wardogs'),[chapters[0]]);
  assert.equal(insideGame(chapters,'wardogs',100,150),true);
  assert.equal(insideGame(chapters,'wardogs',5160,5180),false);
  assert.equal(insideGame(chapters,'wardogs',5500,5530),false);
  assert.equal(insideGame(chapters,'dota_2',5500,5530),true);
  assert.deepEqual(gameWindows(chapters,'unknown'),[]);
});
test('bounds source download to requested gameplay and rejects crossing games or oversized ranges',()=>{
  assert.deepEqual(selectedGameWindow(chapters,'wardogs',{start:2100,end:3000}),{start:2100,end:3000,title:'WARDOGS'});
  assert.deepEqual(selectedGameWindow(chapters,'dota_2',{start:6000,end:6600}),{start:6000,end:6600,title:'Dota 2'});
  for(const range of [{start:5000,end:5200},{start:3000,end:2100},{start:-1,end:200},{start:6000,end:Infinity}])assert.throws(()=>selectedGameWindow(chapters,'wardogs',range));
  assert.throws(()=>selectedGameWindow([{title:'WARDOGS',start:0,end:20000}],'wardogs',{start:0,end:10000}));
});
