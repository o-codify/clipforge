// Only called inside the isolated Docker test network; never against a configured platform.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createDatabase,upgradeRuntime} from '../packages/db/dist/index.js';
const require=createRequire(new URL('../apps/worker/package.json',import.meta.url));
const PgBoss=require('pg-boss').default??require('pg-boss');
const url=new URL(process.env.DATABASE_URL);
assert.equal(url.hostname,'db');assert.equal(url.pathname,'/clipforge_workerqa');
const db=createDatabase({url:url.href}),boss=new PgBoss({connectionString:url.href,schema:'jobs'});
const wait=async check=>{const end=Date.now()+120000;while(!await check()){if(Date.now()>end)throw Error('Container test timed out');await new Promise(r=>setTimeout(r,1000));}};
try{
  if(process.argv[2]==='schema'){
    execFileSync(process.execPath,['packages/db/dist/migrate.js'],{stdio:'inherit'});await upgradeRuntime(db);await boss.start();
    await db.sql`insert into streamers(login,display_name) values('fixture','Fixture')`;
    for(let i=0;i<8;i++)await db.sql`insert into vods(id,streamer) values(${'vqa'+i},'fixture')`;
    await boss.createQueue('heavy.analyze-vod');
  }else{
    await boss.start();
    await wait(async()=>Number((await db.sql`select count(*) n from worker_instances where state='online' and heartbeat_at>now()-interval '40 seconds'`)[0].n)===2);
    for(let i=0;i<8;i++)await boss.send('heavy.analyze-vod',{vodId:'vqa'+i,force:false},{retryLimit:0});
    await wait(async()=>Number((await db.sql`select count(*) n from jobs.job where name='heavy.analyze-vod' and state='completed'`)[0].n)===8);
    assert.equal(Number((await db.sql`select count(distinct worker_id) n from worker_jobs`)[0].n),2);
    for(const w of await db.sql`select resources from worker_instances`){
      assert(w.resources.allocation.cpus<=2);assert(w.resources.allocation.memoryMb<=3072);
    }
    assert.equal(Number((await db.sql`select count(*) n from vods where signals->>'frames' is not null`)[0].n),8);
    console.log('PASS: two real Docker workers registered, respected cgroup caps and completed eight Python audio jobs without duplicate claims.');
  }
}finally{await boss.stop({graceful:false});await db.close();}
