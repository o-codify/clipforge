import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const image = process.argv[2] ?? "clipforge:deployment-test";
const suffix = randomBytes(5).toString("hex");
const app = `clipforge-test-app-${suffix}`;
const replacement = `clipforge-test-next-${suffix}`;
const db = `clipforge-test-db-${suffix}`;
const network = `clipforge-test-net-${suffix}`;
const volume = `clipforge-test-files-${suffix}`;
const secret = randomBytes(24).toString("base64url");
function docker(args, optional = false) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 180_000, windowsHide: true });
  if (result.status !== 0 && !optional) throw new Error(`Docker ${args[0]} failed: ${result.stderr || "process failed"}`);
  return result.stdout?.trim() ?? "";
}
async function until(fn, label, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`Timed out: ${label}`);
}
const inspect = () => JSON.parse(docker(["inspect", app]))[0];
const execNode = code => docker(["exec", app, "node", "--input-type=module", "-e", code]);
const dbCode = code => `import {createContext} from './apps/worker/dist/context.js';const ctx=createContext();try{${code}}finally{await ctx.close()}`;
try {
  docker(["network", "create", network]);
  docker(["volume", "create", volume]);
  docker(["run", "-d", "--name", db, "--network", network, "-e", `POSTGRES_PASSWORD=${secret}`, "-e", "POSTGRES_DB=clipforge", "postgres:17-alpine"]);
  docker(["run", "-d", "--name", app, "--network", network, "--restart", "unless-stopped", "--stop-timeout", "50",
    "-p", "127.0.0.1::3000", "-v", `${volume}:/storage`, "-e", `DATABASE_URL=postgresql://postgres:${secret}@${db}:5432/clipforge`,
    "-e", `ADMIN_PASSWORD=${secret}`, "-e", "AUTO_PUBLISH_ENABLED=false", "-e", "DEV_MODE=true", image]);
  await until(() => inspect().State.Health?.Status === "healthy", "fresh database and all services ready");
  const port = inspect().NetworkSettings.Ports["3000/tcp"][0].HostPort;
  const origin = `http://127.0.0.1:${port}`;
  for (const path of ["/about", "/privacy", "/terms", "/login"]) {
    assert.equal((await fetch(origin + path)).status, 200, path);
  }
  assert.equal((await fetch(origin + "/api/clips")).status, 401);
  assert.equal((await fetch(origin + "/api/platforms")).status, 401);
  console.log("PASS: production UI, public pages, private API protection and fresh migrations");
  execNode("import{writeFileSync}from'node:fs';writeFileSync('/storage/data/recovery-marker','persistent')");
  const seeded = execNode(dbCode("const rows=await ctx.db.sql`select id from accounts`;console.log(rows[0].id)"));
  // A disconnected PC leaves work queued; control must never execute media jobs.
  execNode(dbCode(`const {default:PgBoss}=await import('./apps/worker/node_modules/pg-boss/src/index.js');const boss=new PgBoss({connectionString:process.env.DATABASE_URL,schema:'jobs'});await boss.start();await boss.send('heavy.pipeline',{vodId:'deployment-probe'},{retryLimit:2});await boss.stop();`));
  let before = inspect().RestartCount;
  execNode("import{readFileSync}from'node:fs';const beat=JSON.parse(readFileSync('/tmp/clipforge/worker.json','utf8'));process.kill(beat.pid,'SIGKILL')");
  await until(() => {const state=inspect();return state.RestartCount>before && state.State.Health?.Status==="healthy";}, "worker crash recovery");
  assert.equal(execNode("import{readFileSync}from'node:fs';console.log(readFileSync('/storage/data/recovery-marker','utf8'))"), "persistent");
  assert.equal(execNode(dbCode("const rows=await ctx.db.sql`select id from accounts`;console.log(rows[0].id)")), seeded);
  assert.equal(execNode(dbCode("const rows=await ctx.db.sql`select state from jobs.job where name='heavy.pipeline'`;console.log(rows[0].state)")), "created");
  console.log("PASS: control crash recovery, persistent data and media queue retained while PC is offline");
  before = inspect().RestartCount;
  docker(["stop", "-t", "5", db]);
  await until(() => inspect().RestartCount > before, "database outage detected");
  docker(["start", db]);
  await until(() => inspect().State.Health?.Status === "healthy", "database reconnection");
  console.log("PASS: service recovers after PostgreSQL outage");
  docker(["restart", "-t", "50", app]);
  await until(() => inspect().State.Health?.Status === "healthy", "deployment restart");
  assert.equal(execNode(dbCode("const rows=await ctx.db.sql`select id from accounts`;console.log(rows[0].id)")), seeded);
  assert.equal(execNode("import{readFileSync}from'node:fs';console.log(readFileSync('/storage/data/recovery-marker','utf8'))"), "persistent");
  console.log("PASS: normal restart applies migrations again without resetting data");
  docker(["run", "-d", "--name", replacement, "--network", network, "--stop-timeout", "50",
    "-p", "127.0.0.1::3000", "-v", `${volume}:/storage`, "-e", `DATABASE_URL=postgresql://postgres:${secret}@${db}:5432/clipforge`,
    "-e", `ADMIN_PASSWORD=${secret}`, "-e", "AUTO_PUBLISH_ENABLED=false", "-e", "DEV_MODE=true", image]);
  const nextState = () => JSON.parse(docker(["inspect", replacement]))[0];
  const nextExec = code => docker(["exec", replacement, "node", "--input-type=module", "-e", code]);
  const heartbeatState = "import{readFileSync}from'node:fs';console.log(JSON.parse(readFileSync('/tmp/clipforge/worker.json','utf8')).state)";
  await until(() => nextState().State.Health?.Status === "healthy", "rolling replacement ready while original stays online");
  assert.equal(nextExec(heartbeatState), "standby");
  assert.equal(execNode(heartbeatState), "online");
  assert.equal(execNode(dbCode("const rows=await ctx.db.sql`select count(*) as n from pg_locks where locktype='advisory' and classid=0 and objid=740021 and objsubid=1 and granted`;console.log(rows[0].n)")), "1");
  // Docker can allocate a different ephemeral host port after restart.
  const activePort = inspect().NetworkSettings.Ports["3000/tcp"][0].HostPort;
  assert.equal((await fetch(`http://127.0.0.1:${activePort}/api/health/ready`)).status, 200);
  docker(["stop", "-t", "50", app]);
  await until(() => nextExec(heartbeatState) === "online" && nextState().State.Health?.Status === "healthy", "replacement takes over control after old container stops");
  assert.equal(nextExec(dbCode("const rows=await ctx.db.sql`select state from jobs.job where name='heavy.pipeline'`;console.log(rows[0].state)")), "created");
  console.log("PASS: rolling deployment serves HTTP before old container stops, with one active controller and preserved media queue");
} catch (error) {
  console.error(String(error.stack ?? error));
  const logs = docker(["logs", "--tail", "70", app], true);
  console.error(logs.replaceAll(secret, "[redacted]"));
  console.error(docker(["logs", "--tail", "20", replacement], true).replaceAll(secret, "[redacted]"));
  process.exitCode = 1;
} finally {
  docker(["rm", "-f", app, replacement, db], true);
  docker(["volume", "rm", volume], true);
  docker(["network", "rm", network], true);
}
