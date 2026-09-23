// Run inside the disposable CI container. Reproduce an already populated migration ledger.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createDatabase} from '../packages/db/dist/client.js';
const require=createRequire(new URL('../packages/db/package.json',import.meta.url));
const {readMigrationFiles}=require('drizzle-orm/migrator');
const origin=new URL(process.env.DATABASE_URL);
assert.match(origin.hostname,/^clipforge-test-db-/,'Disposable CI database required');
const name=`clipforge_upgrade_${randomBytes(6).toString('hex')}`;
const admin=createDatabase({url:origin.href});
let db;
try {
  await admin.sql.unsafe(`create database ${name}`);
  const target=new URL(origin);target.pathname=`/${name}`;
  db=createDatabase({url:target.href});
  const migrations=readMigrationFiles({migrationsFolder:'packages/db/migrations'});
  assert.ok(migrations.length>=3);
  await db.sql.begin(async tx=>{
    await tx`create schema drizzle`;
    await tx`create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)`;
    for(const migration of migrations.slice(0,2)){
      for(const statement of migration.sql)await tx.unsafe(statement);
      await tx`insert into drizzle.__drizzle_migrations(hash,created_at)values(${migration.hash},${migration.folderMillis})`;
    }
    await tx`insert into platform_accounts(id,platform,label,external_id,credentials) values('upgrade-channel','youtube','Preserved channel','upgrade-channel','{}')`;
  });
  const run=()=>spawnSync(process.execPath,['packages/db/dist/migrate.js'],{env:{...process.env,DATABASE_URL:target.href},encoding:'utf8',timeout:60000});
  for(let i=0;i<2;i++){
    const result=run();assert.equal(result.status,0,result.stderr);
    const [row]=await db.sql`select label,verified_at,disconnect_requested_at from platform_accounts where id='upgrade-channel'`;
    assert.equal(row.label,'Preserved channel');assert.equal(row.verifiedAt,null);assert.equal(row.disconnectRequestedAt,null);
    const ledger=await db.sql`select hash,created_at from drizzle.__drizzle_migrations order by created_at`;
    assert.deepEqual(ledger.map(row=>[row.hash,Number(row.createdAt)]),migrations.map(row=>[row.hash,row.folderMillis]));
  }
  // A mismatched ledger must stop startup instead of silently serving a partial schema.
  await db.sql`update drizzle.__drizzle_migrations set hash='mismatch' where created_at=${migrations[0].folderMillis}`;
  assert.notEqual(run().status,0);
  console.log('PASS: populated database upgrades, restart preserves channel, mismatched migration ledger stops startup');
}finally{
  await db?.close();
  await admin.sql.unsafe(`drop database if exists ${name}`);
  await admin.close();
}
