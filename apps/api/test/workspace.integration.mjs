// Run against a local API/database. All temporary accounts and catalog fixtures are removed.
import '../dist/config.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, accounts, sessions } from '../../../packages/db/dist/index.js';
import { hashPassword } from '../dist/auth/password.js';

const origin = process.env.TEST_API_ORIGIN ?? 'http://localhost:8420';
assert(['localhost','127.0.0.1'].includes(new URL(origin).hostname), 'Use a local test API');
const db = createDatabase({ url: process.env.DATABASE_URL, max: 2 });
const ids = [];
const fixture = 'workspace_' + randomUUID().replaceAll('-', '');
let checks = 0;
async function account(role, streamer = null) {
  const id = randomUUID(); ids.push(id);
  await db.insert(accounts).values({ id, login: id, passwordHash: await hashPassword(randomUUID()), role, streamer });
  const token = randomUUID();
  await db.insert(sessions).values({ token, accountId: id, expiresAt: new Date(Date.now() + 600000) });
  return token;
}
async function request(token, path, status = 200, method = 'GET', body) {
  const response = await fetch(origin + path, { method, headers: { cookie: `clipforge_session=${token}`, 'content-type':'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, status, `${method} ${path}`); checks++;
  return response.json();
}
async function checkCounts(token, scope = null) {
  const start = performance.now();
  const games = await request(token, '/api/games');
  const duration = Math.round(performance.now() - start);
  // Independent correlated counts catch join multiplication and cross-account leakage.
  const expected = await db.sql`select g.slug,
    (select count(*)::int from streamer_games s where s.game=g.slug and (${scope}::text is null or s.streamer=${scope})) streamers,
    (select count(*)::int from vods v where v.game=g.slug and (${scope}::text is null or v.streamer=${scope})) vods,
    (select count(*)::int from clips c where c.game=g.slug and c.archived_at is null and (${scope}::text is null or c.streamer=${scope})) clips
    from games g`;
  const visible = expected.filter(g => !scope || g.streamers || g.vods || g.clips);
  assert.equal(games.length, visible.length);
  for (const game of visible) {
    const actual = games.find(g => g.slug === game.slug); assert(actual);
    for (const key of ['streamers','vods','clips']) assert.equal(actual[key], game[key], `${game.slug}.${key}`);
  }
  const channels = await request(token, '/api/streamers');
  for (const channel of channels) {
    if (scope) assert.equal(channel.login, scope);
    const [count] = await db.sql`select (select count(*)::int from vods where streamer=${channel.login}) vods,
      (select count(*)::int from clips where streamer=${channel.login} and archived_at is null) clips`;
    assert.equal(channel.vods, count.vods); assert.equal(channel.clips, count.clips);
  }
  return { games: games.length, channels: channels.length, durationMs: duration };
}
try {
  await db.sql`insert into streamers(login,display_name) values(${fixture},'Workspace fixture')`;
  await db.sql`insert into games(slug,title) values(${fixture},'Workspace fixture')`;
  await db.sql`insert into vods(id,streamer,game,title) values(${fixture},${fixture},${fixture},'Workspace fixture')`;
  const admin = await account('admin'), user = await account('user', fixture), unlinked = await account('user');
  const all = await checkCounts(admin);
  const own = await checkCounts(user, fixture);
  assert.equal(own.games, 1, 'A VOD game must be visible even without streamer_games entry');
  const preview = await request(admin, '/api/auth/act-as', 201, 'POST', { streamer: fixture });
  assert.equal(preview.viewer.role, 'user'); assert.equal(preview.viewer.isAdmin, false); assert.equal(preview.viewer.isPreview, true);
  assert.equal((await request(admin, '/api/auth/me')).viewer.isAdmin, false);
  await checkCounts(admin, fixture);
  for (const token of [admin, user, unlinked]) {
    for (const path of ['/api/auth/accounts', '/api/platforms', '/api/discovery/status']) await request(token, path, 403);
    await request(token, '/api/operations/pause', 403, 'POST', { paused: true });
  }
  await request(admin, '/api/auth/profile', 403, 'POST', { displayName:'Forbidden' });
  await request(admin, '/api/jobs/pipeline/' + fixture, 403, 'POST', {});
  await request(user, '/api/auth/act-as', 403, 'POST', { streamer: null });
  const [foreign] = await db.sql`select id from vods where streamer<>${fixture} limit 1`;
  if (foreign) { await request(user, '/api/vods/' + foreign.id, 404); await request(admin, '/api/vods/' + foreign.id, 404); }
  assert.deepEqual(await request(unlinked, '/api/games'), []);
  assert.deepEqual(await request(unlinked, '/api/streamers'), []);
  for (const displayName of ['', 'x'.repeat(101)]) await request(user, '/api/auth/profile', 400, 'POST', { displayName });
  for (const password of ['x'.repeat(7), 'x'.repeat(201)]) await request(user, '/api/auth/password', 400, 'POST', { current:'Invalid', password });
  const restored = await request(admin, '/api/auth/act-as', 201, 'POST', { streamer: null });
  assert.equal(restored.viewer.isAdmin, true); assert.equal(restored.viewer.isPreview, false);
  await request(admin, '/api/auth/accounts');
  const adminViewer=(await request(admin, '/api/auth/me')).viewer;
  await request(admin, '/api/auth/accounts/'+adminViewer.accountId, 201, 'POST', {displayName:'Workspace admin',role:'admin',streamer:null});
  assert.equal((await request(admin, '/api/auth/me')).viewer.displayName,'Workspace admin','Unchanged role/channel must not invalidate the session');
  console.log(JSON.stringify({ result:'PASS', httpChecks:checks, catalog:all, scoped:own, preview:'read-only user; admin restored', profile:'name/password bounds checked' }));
} finally {
  for (const id of ids) await db.sql`delete from accounts where id=${id}`;
  await db.sql`delete from vods where id=${fixture}`;
  await db.sql`delete from streamers where login=${fixture}`;
  await db.sql`delete from games where slug=${fixture}`;
  await db.close();
}
