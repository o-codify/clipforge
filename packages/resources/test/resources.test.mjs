import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ByteBudget,resourceState,activeTimeout,resourceRequest,ResourcePauseError} from '../dist/index.js';
test('missing/stale governor fails closed and preserves the preemption receipt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cf-resources-')),file=join(dir,'state.json');
 try {
  assert.equal(resourceState(file).paused,true);
  writeFileSync(file,JSON.stringify({at:Date.now()-20000,paused:false,preempted:{'42':Date.now()}}));
  assert.equal(resourceState(file).paused,true);
  assert.ok(resourceState(file).preempted['42']);
  writeFileSync(file,JSON.stringify({at:Date.now(),paused:false}));
  assert.equal(resourceState(file).paused,false);
 } finally {rmSync(dir,{recursive:true});}
});
test('concurrent transfers share a budget instead of multiplying it',async()=>{
 const budget=new ByteBudget('upload',()=>({at:Date.now(),paused:false,uploadKbps:256}));
 const before=Date.now();
 await Promise.all([budget.consume(16000,0),budget.consume(16000,0),budget.consume(16000,0)]);
 assert.ok(Date.now()-before>=1450,'48 KB at 32 KB/s cannot finish in 0.5s');
});
test('an in-flight byte budget stops and resumes with foreground activity',async()=>{
 let paused=true,done=false;
 const budget=new ByteBudget('download',()=>({at:Date.now(),paused,downloadKbps:8000}));
 const pending=budget.consume(16000,0).then(()=>{done=true;});
 await delay(220);assert.equal(done,false);paused=false;await pending;assert.equal(done,true);
});
test('working deadline excludes time paused by governor',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cf-deadline-')),file=join(dir,'state.json'),old=process.env.MEDIA_RESOURCE_STATE;
 process.env.MEDIA_RESOURCE_STATE=file;
 let fired=false;
 try {
  writeFileSync(file,JSON.stringify({at:Date.now(),paused:true}));
  const timer=activeTimeout(()=>{fired=true;},200);
  await delay(350);assert.equal(fired,false);
  writeFileSync(file,JSON.stringify({at:Date.now(),paused:false}));
  await delay(450);assert.equal(fired,true);clearInterval(timer);
 } finally { if(old===undefined)delete process.env.MEDIA_RESOURCE_STATE;else process.env.MEDIA_RESOURCE_STATE=old;rmSync(dir,{recursive:true}); }
});
test('cancelled transfer releases a paused budget lane',async()=>{
 let paused=true;
 const budget=new ByteBudget('upload',()=>({at:Date.now(),paused,uploadKbps:8000}));
 const controller=new AbortController();
 const cancelled=assert.rejects(budget.consume(16000,0,controller.signal),{name:'AbortError'});
 controller.abort();await cancelled;paused=false;await budget.consume(100,0);
});
test('foreground activity closes a network request with a resumable reason',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cf-request-')),file=join(dir,'state.json'),old=process.env.MEDIA_RESOURCE_STATE;
 process.env.MEDIA_RESOURCE_STATE=file;
 try {
  writeFileSync(file,JSON.stringify({at:Date.now(),paused:false}));
  const pending=resourceRequest(async signal=>{await delay(10000,undefined,{signal});});
  const rejected=assert.rejects(pending,ResourcePauseError);
  await delay(50);writeFileSync(file,JSON.stringify({at:Date.now(),paused:true}));
  await rejected;
 } finally {if(old===undefined)delete process.env.MEDIA_RESOURCE_STATE;else process.env.MEDIA_RESOURCE_STATE=old;rmSync(dir,{recursive:true});}
});
