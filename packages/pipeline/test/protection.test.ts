import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildFilter,computeGrid} from '../dist/layout.js';
import {buildFfmpegArgs} from '../dist/render.js';
import {workerOps} from '@clipforge/contracts';

test('ad screening ignores legacy enhancement and speech-gate parameters',()=>{
 const input=workerOps.prepareMedia.params.parse({video:'source.mp4',start:0,end:20,
  method:'deepfilter',speechSpans:[[1,2]],out:'speech.wav',models:'missing'});
 assert.deepEqual(input,{video:'source.mp4',start:0,end:20,transcript:'',regions:[],models:'missing'});
});

test('DTLN is explicitly selected per run and must provide a processed audio file without gating',()=>{
 assert.equal(workerOps.prepareMedia.params.parse({video:'source.mp4',start:0,end:20}).audioMode,undefined);
 const audio={method:'dtln',file:'speech.wav',speechGated:false,duration:20,rmsBefore:.1,rmsAfter:.05};
 assert.equal(workerOps.prepareMedia.result.shape.audio.parse(audio).file,'speech.wav');
 assert.throws(()=>workerOps.prepareMedia.result.shape.audio.parse({...audio,file:undefined}));
 assert.throws(()=>workerOps.prepareMedia.result.shape.audio.parse({...audio,speechGated:true}));
});

test('ad-masked renders keep source audio without enhancement or speech gating',()=>{
 const {args,graph}=buildFfmpegArgs({source:'original.mp4',start:10,end:30,out:'ads-hidden.mp4',
  grid:computeGrid(1280,720,null),assets:{root:'missing-test-assets'},sourceMasks:[{x:1100,y:20,w:150,h:150}]},null);
 assert.equal(args.filter(value=>value==='-i').length,1);
 assert.ok(args.includes('0:a'));assert.match(graph,/drawbox/);
 assert.doesNotMatch(graph,/\[\d+:a\]|agate|afftdn|highpass|lowpass/);
});
test('ad masks are applied before all crops and blurred-background copies',()=>{
 const graph=buildFilter(computeGrid(1280,720,null),{sourceMasks:[{x:1100,y:20,w:150,h:150}]});
 assert.match(graph,/^\[0:v\]drawbox=x=1100:y=20:w=150:h=150:color=0x18161e:t=fill,split=/);
 assert.ok(graph.indexOf('drawbox')<graph.indexOf('gblur'));
});
test('clean audio is the only mapped source, including censorship and outro duration',()=>{
 const options={source:'original.mp4',start:10,end:30,out:'clean.mp4',grid:computeGrid(1280,720,null),
  assets:{root:'missing-test-assets'},audioSource:'speech.wav',censorSpans:[[11,12] as const],censorBeep:false};
 const {args,graph}=buildFfmpegArgs(options,null);
 assert.ok(args.includes('speech.wav'));assert.match(graph,/\[1:a\]volume/);assert.doesNotMatch(graph,/\[0:a\]/);
 assert.equal(args[args.indexOf('[vout]')+2],'[aout]');
 assert.equal(args[args.indexOf('-filter_complex_threads')+1],'1');
 for(let i=0;i<args.length;i++)if(args[i]==='-i'){
   assert.deepEqual(args.slice(i-2,i),['-threads','2']);
 }
});
