import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeRussianText,displayTranscript,maskProfanity} from '@clipforge/contracts/text';
import {normalizeTranscriptWords,buildAss,defaultStyle,textBetween} from '../dist/index.js';

test('repairs detached suffixes and punctuation but preserves dashes and ordinary words',()=>{
  assert.equal(normalizeRussianText(' Пинг -то  меньше , кто- то тут ? '),'Пинг-то меньше, кто-то тут?');
  assert.equal(normalizeRussianText('Это - то, что нужно. Дота — игра.'),'Это - то, что нужно. Дота — игра.');
  assert.equal(maskProfanity('мандарин, художник, вебинар, команда'),'мандарин, художник, вебинар, команда');
  assert.equal(displayTranscript('« Блядь », наxуй!'),'«Б****», н****!');
});

test('joins timed suffix before ASS wrapping without mutating input',()=>{
  const words=[{text:'Пинг',start:0,end:.4},{text:'-то',start:.4,end:.6},{text:'меньше',start:.6,end:1},{text:',',start:1,end:1},{text:'блядь!',start:1.1,end:1.5}];
  const before=structuredClone(words);
  const joined=normalizeTranscriptWords(words);
  assert.deepEqual(joined.slice(0,2),[{text:'Пинг-то',start:0,end:.6},{text:'меньше,',start:.6,end:1}]);
  assert.deepEqual(words,before);
  assert.equal(textBetween(words,0,2),'Пинг-то меньше, блядь!');
  const ass=buildAss({language:'ru',duration:2,segments:[{start:0,end:2,text:'',words}]},0,2,1080,1920,{style:defaultStyle({censor:true})});
  assert.match(ass,/Пинг-то/);
  assert.match(ass,/б\*\*\*\*!/);
  assert.doesNotMatch(ass,/Пинг -то|блядь/);
});
