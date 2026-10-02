import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {WorkerGatewayController} from '../dist/worker-gateway.controller.js';

test('worker operations return valid JSON for game slugs, null, counts and objects',async()=>{
  let value;
  const controller=new WorkerGatewayController({operation:async()=>value});
  const app=Fastify();
  app.post('/operation',(req,reply)=>controller.operation('Bearer fixture','lease',req.body,reply));
  try {
    for(value of ['dota_2','wardogs',null,0,{id:'v1'}]) {
      const response=await app.inject({method:'POST',url:'/operation',payload:{operation:'fixture'}});
      assert.equal(response.statusCode,200);
      assert.match(response.headers['content-type'],/application\/json/);
      assert.deepEqual(response.json(),value);
    }
  } finally {await app.close();}
});
