// Local regression: grouping, paginated history, viewer isolation and account editors.
import '../dist/config.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, accounts, sessions } from '../../../packages/db/dist/index.js';
import { hashPassword } from '../dist/auth/password.js';

const origin=process.env.TEST_API_ORIGIN??'http://localhost:8420';
assert(['localhost','127.0.0.1'].includes(new URL(origin).hostname));
assert(['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
const db=createDatabase({url:process.env.DATABASE_URL,max:2});
const fixture='groups_'+randomUUID().replaceAll('-','');
const accountIds=[], jobIds=[], automationId=randomUUID();
let checks=0;
async function account(role,streamer=null){
  const id=randomUUID();accountIds.push(id);
  await db.insert(accounts).values({id,login:id,passwordHash:await hashPassword(randomUUID()),role,streamer});
  const token=randomUUID();await db.insert(sessions).values({token,accountId:id,expiresAt:new Date(Date.now()+600000)});return token;
}
async function request(token,path,status=200,method='GET',body){
  const response=await fetch(origin+path,{method,headers:{cookie:`clipforge_session=${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(response.status,status,`${method} ${path}`);checks++;return response.json();
}
async function job(name,streamer,state,index){
  const id=randomUUID();jobIds.push(id);
  // Future start_after prevents any local queue poller from executing fixtures.
  await db.sql`insert into jobs.job(id,name,state,data,created_on,start_after,output)
    values(${id},${name},${state},${JSON.stringify({login:streamer})}::jsonb,now()-${index}*interval '1 minute',now()+interval '1 year','{"found":10,"added":1}')`;
  return id;
}
const history=(name,streamer,offset=0)=>'/api/jobs/group-runs?'+new URLSearchParams({name,streamer,offset:String(offset)});
try{
  await db.sql`insert into streamers(login,display_name,avatar) values(${fixture},'Group A','/test-avatar.png'),(${fixture+'_b'},'Group B',null)`;
  const admin=await account('admin'),user=await account('user',fixture),unlinked=await account('user');
  const queue='light.index-channel';
  for(let i=0;i<32;i++)await job(queue,fixture,i===0?'active':i===1?'retry':i===2?'failed':'completed',i);
  await job(queue,fixture+'_b','completed',500);
  await db.sql`insert into automation_runs(id,name,state,output) values(${automationId},'platform.discovery','completed','{"inspected":4,"added":1}')`;
  const groups=await request(admin,'/api/jobs/groups');
  const a=groups.filter(g=>g.streamer===fixture);assert.equal(a.length,1);assert.equal(a[0].runs,32);assert.equal(a[0].completed,29);assert.equal(a[0].active,1);assert.equal(a[0].waiting,1);assert.equal(a[0].failed,1);assert.equal(a[0].recurring,true);assert.equal(a[0].avatar,'/test-avatar.png');
  assert(groups.some(g=>g.streamer===fixture+'_b'),'Older channel must remain visible');
  assert(groups.some(g=>g.name==='platform.discovery'&&g.recurring));
  const first=await request(admin,history(queue,fixture));assert.equal(first.runs.length,30);assert.equal(first.nextOffset,30);
  const second=await request(admin,history(queue,fixture,30));assert.equal(second.runs.length,2);assert.equal(second.nextOffset,null);
  assert.equal(new Set([...first.runs,...second.runs].map(r=>r.id)).size,32);
  const own=await request(user,'/api/jobs/groups');assert.equal(own.length,1);assert.equal(own[0].streamer,fixture);
  assert.equal((await request(user,history(queue,fixture+'_b'))).runs.length,0);
  assert.equal((await request(user,history('platform.discovery',''))).runs.length,0);
  assert.equal((await request(user,history(queue,fixture))).runs.find(r=>r.state==='failed').output,null);
  assert.deepEqual(await request(unlinked,'/api/jobs/groups'),[]);
  await request(admin,'/api/auth/act-as',201,'POST',{streamer:fixture});
  assert.equal((await request(admin,'/api/jobs/groups')).length,1);
  assert.equal((await request(admin,history(queue,fixture+'_b'))).runs.length,0);
  await request(admin,'/api/auth/act-as',201,'POST',{streamer:null});
  await request(admin,'/api/platforms'); // Regression for missing disconnect_requested_at migration.
  const ops=await request(admin,'/api/operations');
  for(const value of Object.values(ops.runtime))assert(!Number.isNaN(Date.parse(value.updatedAt)),'Runtime timestamps must be supplied');
  await request(user,'/api/auth/accounts',403);
  await request(admin,'/api/auth/accounts',400,'POST',{login:fixture+'_account',role:'user',streamer:fixture,password:randomUUID()});
  await request(admin,'/api/auth/accounts',201,'POST',{login:fixture+'_account',displayName:'Тестовый пользователь',role:'user',streamer:fixture+'_b',password:randomUUID()});
  const rows=await request(admin,'/api/auth/accounts');const newAccount=rows.find(r=>r.login===fixture+'_account');assert(newAccount);accountIds.push(newAccount.id);assert.equal(newAccount.displayName,'Тестовый пользователь');
  await request(admin,'/api/auth/accounts/'+newAccount.id,201,'POST',{displayName:'Новое имя',role:'moderator',streamer:null});
  const changed=(await request(admin,'/api/auth/accounts')).find(r=>r.id===newAccount.id);assert.equal(changed.displayName,'Новое имя');assert.equal(changed.role,'moderator');assert.equal(changed.streamer,null);
  for(const password of ['short','x'.repeat(201)])await request(admin,'/api/auth/accounts/'+newAccount.id+'/password',400,'POST',{password});
  for(const login of ['x','x'.repeat(65),'bad login'])await request(admin,'/api/auth/accounts',400,'POST',{login,password:randomUUID()});
  console.log(JSON.stringify({result:'PASS',httpChecks:checks,grouping:'32 runs -> 1 recurring task',history:'30+2 unique runs',scope:'user, unlinked and preview isolated',accounts:'create, edit, validation',publication:'connections load'}));
}finally{
  for(const id of jobIds)await db.sql`delete from jobs.job where id=${id}`;
  await db.sql`delete from automation_runs where id=${automationId}`;
  await db.sql`delete from accounts where login=${fixture+'_account'}`;
  for(const id of accountIds)await db.sql`delete from accounts where id=${id}`;
  await db.sql`delete from streamers where login in (${fixture},${fixture+'_b'})`;
  await db.close();
}
