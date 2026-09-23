import '../dist/config.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,accounts,sessions} from '../../../packages/db/dist/index.js';
import {hashPassword} from '../dist/auth/password.js';
const db=createDatabase({url:process.env.DATABASE_URL}),id=`test_${randomUUID()}`,token=randomUUID();
try {
 await db.insert(accounts).values({id,login:id,role:'admin',passwordHash:await hashPassword(randomUUID())});
 await db.insert(sessions).values({token,accountId:id,expiresAt:new Date(Date.now()+600000)});
 const get=async path=>{const r=await fetch(`http://localhost:8420${path}`,{headers:{cookie:`clipforge_session=${token}`}});assert.equal(r.status,200,path);return r.json();};
 const [counts]=await db.sql`select count(*) filter(where archived_at is null)::int active,count(*) filter(where archived_at is not null)::int archived from clips`;
 assert(counts.archived>=191);
 const list=await get('/api/clips?limit=300');assert.equal(list.length,counts.active);assert(list.every(c=>!c.archivedAt&&!c.archived_at));
 assert.equal((await get('/api/summary')).clips,counts.active);
 for(const path of ['/api/streamers','/api/games'])assert.equal((await get(path)).reduce((n,row)=>n+row.clips,0),counts.active,path);
 const [old]=await db.sql`select id,run_id as "runId" from clips where archived_at is not null limit 1`;
 assert.equal((await fetch(`http://localhost:8420/api/clips/${old.id}`,{headers:{cookie:`clipforge_session=${token}`}})).status,404);
 assert.equal((await get(`/api/runs/${old.runId}`)).clips.length,0);
 for(const c of list) {
  const detail=await get(`/api/clips/${c.id}`);
  assert(detail.versions.every(v=>list.some(c=>c.id===v.id)));
 }
 console.log(`PASS: ${counts.active} active, ${counts.archived} archived; lists, counts, versions and old detail routes agree`);
}finally{await db.sql`delete from accounts where id=${id}`;await db.close();}
