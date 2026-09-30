import 'reflect-metadata';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JobsService} from '../dist/jobs/jobs.service.js';

function service(row, competing=false) {
  const retries=[];
  let reads=0;
  const db={
    execute:async()=>++reads===1?(row?[row]:[]):[{state:'retry'}],
    transaction:async work=>{
      let statements=0;
      return work({execute:async()=>++statements===1?[]:competing?[{id:'other-batch'}]:[]});
    },
  };
  const jobs=new JobsService({},db);
  jobs.queue=async()=>({retry:async(name,id)=>{retries.push({name,id})}});
  return {jobs,retries};
}

test('resume keeps the batch identity used by checkpoints and the approved publication policy',async()=>{
  const {jobs,retries}=service({name:'heavy.prepare-streamer',state:'failed',singletonKey:'sany'});
  assert.deepEqual(await jobs.resumeBatch('batch-id'),{id:'batch-id',resumed:true});
  assert.deepEqual(retries,[{name:'heavy.prepare-streamer',id:'batch-id'}]);
});

test('active batches and competing batches are not enqueued twice',async()=>{
  for(const [state,competing] of [['active',false],['retry',false],['failed',true]]) {
    const {jobs,retries}=service({name:'heavy.prepare-streamer',state,singletonKey:'sany'},competing);
    assert.deepEqual(await jobs.resumeBatch('batch-id'),{id:'batch-id',resumed:false});
    assert.deepEqual(retries,[]);
  }
});

test('resume cannot retry an upload, a cancelled batch or a completed batch',async()=>{
  for(const row of [undefined,{name:'light.publish-batch-clip',state:'failed'},
    {name:'heavy.prepare-streamer',state:'cancelled'},{name:'heavy.prepare-streamer',state:'completed'}]) {
    const {jobs,retries}=service(row);
    await assert.rejects(jobs.resumeBatch('batch-id'));
    assert.deepEqual(retries,[]);
  }
});
