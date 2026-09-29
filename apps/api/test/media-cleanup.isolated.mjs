// Explicitly uses a new disposable database in the LOCAL Docker container.
// Never consumes DATABASE_URL: the development .env can point at a production tunnel.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PgBoss from 'pg-boss';
import { createDatabase, upgradeRuntime, games, streamers, vods, runs, clips } from '../../../packages/db/dist/index.js';
import { QUEUES } from '../../../packages/jobs/dist/index.js';
import { PythonWorker } from '../../../packages/pipeline/dist/index.js';
import { cleanClip } from '../../worker/dist/clean-clip.js';
import { CatalogService } from '../dist/catalog/catalog.service.js';
import { JobsService } from '../dist/jobs/jobs.service.js';
import { JobsController } from '../dist/jobs/jobs.controller.js';
import { PlatformsService } from '../dist/platforms/platforms.service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const docker = (...args) => execFileSync('docker', ['--context', 'desktop-linux', ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
assert.match(docker('context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'), /^npipe:/);
const container = 'clipforge-postgres';
const name = 'clipforge_media_qa_' + randomUUID().replaceAll('-', '');
assert.match(name, /^clipforge_media_qa_[0-9a-f]{32}$/);
const username = docker('exec', container, 'printenv', 'POSTGRES_USER');
const url = new URL('postgres://127.0.0.1:55432/' + name);
url.username = username;
url.password = docker('exec', container, 'printenv', 'POSTGRES_PASSWORD');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '55432');
const psql = query => docker('exec', container, 'psql', '-U', username, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', query);
let created = false, db, jobs, boss, python;
try {
  psql('CREATE DATABASE "' + name + '"');
  created = true;
  execFileSync(process.execPath, ['packages/db/dist/migrate.js'], {
    cwd: root, env: { ...process.env, DATABASE_URL: url.href },
    windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  db = createDatabase({ url: url.href, max: 2 });
  await upgradeRuntime(db);
  assert.equal((await db.sql.unsafe('select current_database() as name'))[0].name, name);
  const [names] = await db.sql.unsafe('select \'{"sany_jeweler":{"clip_id":1}}\'::jsonb as json_payload');
  assert.deepEqual(names.jsonPayload, { sany_jeweler: { clip_id: 1 } });
  const fixture = resolve(root, 'data/reviews/media-protection/ads-fixture.mp4');
  const original = await readFile(fixture);
  await db.insert(games).values({ slug: 'qa_game', title: 'QA Game' });
  await db.insert(streamers).values({ login: 'qa_streamer', displayName: 'QA Streamer' });
  await db.insert(vods).values({ id: 'vqa', streamer: 'qa_streamer', game: 'qa_game', duration: 2 });
  await db.insert(runs).values({ id: 'qa-run', vodId: 'vqa', streamer: 'qa_streamer', game: 'qa_game', outDir: dirname(fixture), settings: {} });
  await db.insert(clips).values({ id: 'qa-clip', runId: 'qa-run', vodId: 'vqa', streamer: 'qa_streamer', game: 'qa_game', segmentKey: 'vqa:0-2000', file: 'ads-fixture.mp4', state: 'ready', start: 0, end: 2, duration: 2, version: 'original' });
  const viewer = { isAdmin: true, actingAs: null, role: 'admin' };
  const catalog = new CatalogService(db);
  jobs = new JobsService({ databaseUrl: url.href }, db);
  const controller = new JobsController(jobs, catalog);
  const platforms = new PlatformsService(db, {}, jobs);
  await assert.rejects(platforms.preview('qa-clip'), /недоступен/);
  // A stale browser may still send the old audio mode; the API must discard it.
  const queued = await controller.cleanClip(viewer, 'qa-clip', { method: 'mute', regions: [{x:1050,y:20,w:180,h:180}] });
  assert.ok(queued.id);
  assert.equal((await controller.cleanClip(viewer, 'qa-clip', { method: 'mute', regions: [{x:1050,y:20,w:180,h:180}] })).id, queued.id);
  boss = new PgBoss({ connectionString: url.href, schema: 'jobs', max: 2 });
  boss.on('error', error => { throw error; });
  await boss.start();
  const [job] = await boss.fetch(QUEUES.cleanClip);
  assert.equal(job.id, queued.id);
  assert.equal('method' in job.data, false);
  const output = resolve(root, 'data/reviews/media-protection/db-integration');
  await mkdir(output, { recursive: true });
  python = new PythonWorker({ pythonBin: resolve(root, '.venv/Scripts/python.exe'), workerRoot: resolve(root, 'workers/python'), cwd: root, timeoutMs: 120000, onStderr: () => {} });
  const ctx = { db, python, storage: null, config: { out: output, models: resolve(root, 'models') } };
  const report = { log: () => {}, cancelled: async () => false };
  const result = await cleanClip(ctx, job.data, report);
  await boss.complete(QUEUES.cleanClip, job.id, result);
  const status = await controller.status(viewer, queued.id);
  assert.equal(status.state, 'completed');
  assert.equal(status.output.clipId, result.clipId);
  const draft = await catalog.clip(viewer, result.clipId);
  assert.equal(draft.state, 'draft');
  assert.ok(draft.safety, JSON.stringify(await db.select({settings:runs.settings}).from(runs)));
  assert.equal(draft.safety.method, 'original');
  assert.equal(draft.safety.regions, 2);
  assert.equal(draft.safety.reviewedAt, null);
  await assert.rejects(catalog.setClipState(viewer, result.clipId, 'ready'), /обработку рекламы/);
  await catalog.setClipState(viewer, result.clipId, 'ready', true);
  const ready = await catalog.clip(viewer, result.clipId);
  assert.equal(ready.state, 'ready');
  assert.ok(ready.safety.reviewedAt);
  assert.match((await platforms.preview(result.clipId)).title, /QA Streamer/);
  // Machine proof on a rendered version unlocks the same durable API/SQL gate,
  // without recording a fictitious human review or bypassing clip state.
  await db.sql`update runs set settings=jsonb_set(settings, array['renderedClips',${result.clipId},'protection'],
    ((settings #> array['renderedClips',${result.clipId},'protection']) - 'reviewedAt') || ${JSON.stringify({autoVerifiedAt:new Date().toISOString(),ads:{automatic:true,profileId:'fixture-source',profileFrames:12,regions:[{},{}]}})}::jsonb)
    where id=${ready.runId}`;
  await catalog.setClipState(viewer,result.clipId,'draft');
  await assert.rejects(platforms.preview(result.clipId),/недоступен/);
  await catalog.setClipState(viewer,result.clipId,'ready');
  const automatic=await catalog.clip(viewer,result.clipId);
  assert.ok(automatic.safety.autoVerifiedAt);
  assert.equal(automatic.safety.reviewedAt,null);
  assert.match((await platforms.preview(result.clipId)).title,/QA Streamer/);
  assert.equal((await cleanClip(ctx, job.data, report)).clipId, result.clipId);
  assert.equal(Number((await db.sql.unsafe('select count(*) as count from clips'))[0].count), 2);
  assert.deepEqual(await readFile(fixture), original);
  assert.equal(Number((await db.sql.unsafe('select count(*) as count from publications'))[0].count), 0);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({
    passed: true, database: 'isolated-local-disposable', queued: true, duplicateRejected: true,
    jobCompleted: true, clipId: result.clipId, newVersion: true, masks: draft.safety.regions,
    reviewRequired: true, reviewedReady: true, retryIdempotent: true, originalUnchanged: true, audioMethod: draft.safety.method,
    externalUploads: 0, verifiedAt: new Date().toISOString(),
  }, null, 2));
  console.log('PASS: isolated queue -> cleanup -> immutable version -> review -> publication preview; original unchanged, zero uploads');
} finally {
  await python?.stop();
  await jobs?.onModuleDestroy();
  await boss?.stop({ graceful: true, timeout: 5000 });
  await db?.close();
  if (created) {
    assert.match(name, /^clipforge_media_qa_[0-9a-f]{32}$/);
    psql('DROP DATABASE "' + name + '" WITH (FORCE)');
    console.log('Disposable local database removed');
  }
}
