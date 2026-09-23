import "../dist/config.js";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createDatabase, accounts, sessions } from "../../../packages/db/dist/index.js";
import { hashPassword } from "../dist/auth/password.js";
import { open } from "node:fs/promises";
import { join } from "node:path";

const db = createDatabase({url:process.env.DATABASE_URL});
const root = process.env.TEST_API_ORIGIN ?? "http://localhost:8420";
for (let attempt=0; attempt<30; attempt++) {
  try { await fetch(`${root}/api/auth/me`, {signal:AbortSignal.timeout(1000)}); break; }
  catch(error) { if(attempt===29) throw error; await new Promise(resolve=>setTimeout(resolve,500)); }
}
const ids=[];
let checks=0;
async function account(role,streamer=null) {
  const id=`test_${randomUUID()}`;ids.push(id);
  await db.insert(accounts).values({id,login:id,passwordHash:await hashPassword("Temporary-test-password!"),role,streamer});
  const token=randomUUID();
  await db.insert(sessions).values({token,accountId:id,expiresAt:new Date(Date.now()+600000)});
  return token;
}
async function request(token,path,status=200,method="GET",body) {
  const response=await fetch(`${root}${path}`,{method,headers:{cookie:`clipforge_session=${token}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  const text=await response.text();
  assert.equal(response.status,status,`${method} ${path}: ${text.slice(0,200)}`);checks++;
  return text ? JSON.parse(text) : null;
}
try {
  const admin=await account("admin");const moderator=await account("moderator");const unlinked=await account("user");
  const channel=await db.sql`select login from streamers order by login limit 1`;
  assert(channel.length,"Integration fixture requires an indexed channel");
  const user=await account("user",channel[0].login);
  await request("","/api/streamers",401);
  const me=await request(unlinked,"/api/auth/me");assert.equal(me.viewer.role,"user");
  for(const path of ["/api/streamers","/api/games","/api/vods","/api/clips","/api/jobs","/api/jobs/active","/api/jobs/conversation","/api/proposals"]){
    assert.deepEqual(await request(unlinked,path),[],`unlinked account leaked ${path}`);
  }
  const summary=await request(unlinked,"/api/summary");assert(Object.values(summary).every(v=>v===0));
  const mine=await request(user,"/api/streamers");assert(mine.every(s=>s.login===channel[0].login));
  const foreign=await db.sql`select id from vods where streamer <> ${channel[0].login} limit 1`;
  if(foreign.length){await request(user,`/api/vods/${foreign[0].id}`,404);await request(user,`/api/jobs/pipeline/${foreign[0].id}`,404,"POST",{});}
  await request(user,"/api/auth/accounts",403);await request(moderator,"/api/auth/accounts",403);
  await request(user,"/api/platforms",403);await request(moderator,"/api/platforms",403);
  await request(moderator,"/api/streamers");await request(moderator,"/api/jobs");
  await request(moderator,"/api/jobs/index-channel",403,"POST",{login:"test"});
  await request(moderator,"/api/operations/pause",403,"POST",{paused:true});
  await request(user,"/api/operations/pause",403,"POST",{paused:true});
  const conversation=await request(moderator,"/api/jobs/conversation");assert(conversation.every(message=>!("technical" in message)),"moderator must not receive raw diagnostics");assert.equal(new Set(conversation.map(message=>message.id)).size,conversation.length,"one card per object");
  await request(admin,"/api/auth/accounts");await request(admin,"/api/operations");
  await request(user,"/api/auth/profile",201,"POST",{displayName:"Test profile",role:"admin"});
  assert.equal((await request(user,"/api/auth/me")).viewer.role,"user");
  await request(admin,"/api/jobs?limit=NaN",400);
  await request(admin,"/api/jobs/not-a-uuid/events",400);
  await request("","/api/auth/register",404,"POST",{});
  const [stored] = await db.sql`select c.id,c.streamer,c.file,r.out_dir from clips c
    join runs r on r.id=c.run_id where c.media_storage is not null and c.archived_at is null limit 1`;
  if (stored) {
    const owner=await account("user",stored.streamer);
    for (const kind of ["clip","poster"]) {
      await request("",`/media/${kind}/${stored.id}`,401);
      await request(unlinked,`/media/${kind}/${stored.id}`,404);
      const redirect=await fetch(`${root}/media/${kind}/${stored.id}`,{headers:{cookie:`clipforge_session=${owner}`},redirect:"manual"});
      assert.equal(redirect.status,302);
      assert.equal(redirect.headers.get("cache-control"),"private, no-store");
      const signed=redirect.headers.get("location");
      assert.equal(new URL(signed).origin,new URL(process.env.S3_ENDPOINT).origin);
      const object=await fetch(signed,{headers:{Range:"bytes=0-127"}});
      assert.equal(object.status,206);
      if(kind==="clip") {
        const file=await open(join(stored.outDir,stored.file));
        try {
          const expected=Buffer.alloc(128);await file.read(expected,0,128,0);
          assert.deepEqual(Buffer.from(await object.arrayBuffer()),expected);
        } finally {await file.close();}
      } else { assert.match(object.headers.get("content-type"),/^image\/jpeg/); await object.arrayBuffer(); }
      checks+=3;
    }
    console.log("PASS: actual S3 clip/poster delivery, byte ranges and account isolation");
  }
  console.log(`PASS: ${checks} HTTP access/validation checks; user isolation, moderator read-only, closed registration`);
} finally {
  for(const id of ids) await db.sql`delete from accounts where id=${id}`;
  await db.close();
}
