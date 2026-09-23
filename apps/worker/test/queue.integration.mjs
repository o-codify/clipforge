import "../dist/context.js";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import PgBoss from "pg-boss";
import { createDatabase, enqueueUnique } from "../../../packages/db/dist/index.js";
const db=createDatabase({url:process.env.DATABASE_URL});
const boss=new PgBoss({connectionString:process.env.DATABASE_URL,schema:"jobs"});
const queue=`test.${randomUUID()}`;
try {
  await boss.start();await boss.createQueue(queue);
  const send=()=>enqueueUnique(db,queue,queue,()=>boss.send(queue,{test:true},{singletonKey:queue}));
  const ids=await Promise.all(Array.from({length:12},send));
  assert.equal(ids.filter(Boolean).length,1,"concurrent producers must enqueue one job");
  const [job]=await boss.fetch(queue);
  assert(job);
  assert.equal(await send(),null,"active job must also suppress duplicates");
  await boss.complete(queue,job.id,{ok:true});
  assert(await send(),"completion permits a new explicit run");
  console.log("PASS: duplicate suppression across 12 concurrent producers, active jobs and completed jobs");
} finally {
  await db.sql`delete from jobs.job where name=${queue}`;
  await boss.deleteQueue(queue);
  await boss.stop({graceful:true});await db.close();
}
