import {test} from "node:test";
import assert from "node:assert/strict";
import {jobMessage} from "../dist/jobs/conversation.js";
const job={id:"job-1",name:"heavy.pipeline",state:"active",data:{vodId:"v1"},createdAt:"2026-09-23T10:00:00Z",output:null};
test("one stable card accumulates progress even when renders finish out of order",()=>{
  const first=jobMessage(job,[{message:"шаг 5/5: нарезка"},{message:"[2/24] ready"}],false);
  const second=jobMessage(job,[{message:"шаг 5/5: нарезка"},{message:"[2/24] ready"},{message:"[1/24] ready"},{message:"[2/24] ready"}],false);
  assert.equal(first.id,second.id);assert.equal(first.time,second.time);
  assert.match(second.text,/готово 2 из 24/);assert.equal(second.steps.filter(s=>s.state==="done").length,4);
  assert.equal(second.technical,undefined);
});
test("completion replaces progress and includes results without raw logs for users",()=>{
  const result=jobMessage({...job,state:"completed",output:{rendered:24}},[{message:"secret internal file"}],false);
  assert(result.steps.every(s=>s.state==="done"));assert.deepEqual(result.facts,[{label:"Создано клипов",value:"24"}]);
  assert(!JSON.stringify(result).includes("secret"));assert.equal(result.id,"work-vod:v1");
});
