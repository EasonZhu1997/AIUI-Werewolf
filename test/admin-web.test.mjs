import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AdminSession, escapeHtml, filteredRooms, roomsHtml, roomDetailHtml, aiHtml, eventsHtml, summaryHtml, durationLabel } from '../admin/view.js';

const snapshot = overrides => ({ version: '0.1.4', adminVersion: '0.1.0', now: 10000, startedAt: 1000, uptimeMs: 9000, summary: { rooms: 2, waitingRooms: 1, activeRooms: 1, onlineHumans: 2, botSeats: 4, connections: 3, directoryConnections: 1, pausedRooms: 0 }, limits: { maxRooms: 12, maxConnections: 72, maxPlayers: 6 }, ai: { configured: true, model: 'deepseek-v4-flash', callsLastHour: 2, maxCallsPerHour: 600, successes: 1, failures: 0, cancellations: 0, inFlight: 1 }, rooms: [{ roomId: '1234', phase: 'lobby', onlineHumans: 1, humans: 1, bots: 0, players: [] }, { roomId: '5678', phase: 'night', onlineHumans: 1, humans: 2, bots: 4, players: [] }], events: [], ...overrides });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(fetcher) {
  let next = 0;
  const timers = new Map(), changes = [], requests = [];
  const session = new AdminSession({ fetcher: (url, options) => { requests.push({ url, options }); return fetcher(url, options); }, schedule: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, unschedule: id => timers.delete(id), now: () => 123456, onChange: state => changes.push(state) });
  return { session, timers, changes, requests };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('room discovery filters by public labels, stage and pause without hidden metadata', () => {
  const rooms = [...snapshot().rooms, { roomId: 'lobby', phase: 'lobby', onlineHumans: 2 }, { roomId: '7777', phase: 'speech', onlineHumans: 0, paused: true }];
  assert.deepEqual(filteredRooms(rooms, '公共').map(r => r.roomId), ['lobby']);
  assert.deepEqual(filteredRooms(rooms, '567', 'active').map(r => r.roomId), ['5678']);
  assert.deepEqual(filteredRooms(rooms, '', 'paused').map(r => r.roomId), ['7777']);
  assert.equal(filteredRooms(rooms, '', 'all')[0].roomId, '7777');
  assert.equal(filteredRooms(null).length, 0);
});

test('user-controlled room, names, model and event text remain escaped inert text', () => {
  const xss = '\"><img src=x onerror=alert(1)>&\'';
  const room = { ...snapshot().rooms[0], roomId: xss, players: [{ seat: 1, name: xss, bot: false, connected: true, alive: true, role: 'SECRET_ROLE' }], hidden: 'SECRET_FIELD' };
  for (const html of [roomsHtml([room]), roomDetailHtml(room), aiHtml({ model: xss }), eventsHtml([{ at: 1000, message: xss, roomId: xss, level: xss }])]) {
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
    assert.ok(!html.includes('SECRET_ROLE'));
    assert.ok(!html.includes('SECRET_FIELD'));
  }
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});

test('night details hide deadlines even if the server accidentally includes one', () => {
  const html = roomDetailHtml({ ...snapshot().rooms[1], deadline: 1740000000000, aiState: 'thinking', chatState: 'idle' });
  assert.match(html, /夜间行动中/);
  assert.ok(!html.includes('1740000000000'));
  assert.match(roomDetailHtml({ ...snapshot().rooms[1], paused: true }), /已暂停/);
  assert.match(roomDetailHtml({ ...snapshot().rooms[0], playback: { pendingAcks: 2, totalHumans: 3 } }), /2 \/ 3 位真人待确认/);
});

test('AI health distinguishes configured, busy, failed, recovered and exhausted budget', () => {
  assert.match(aiHtml({ configured: false }), /尚未配置/);
  assert.match(aiHtml({ configured: true, inFlight: 2 }), /2 个请求进行中/);
  assert.match(aiHtml({ configured: true, lastSuccessAt: 1000, lastFailureAt: 2000 }), /最近一次请求异常/);
  assert.match(aiHtml({ configured: true, lastSuccessAt: 3000, lastFailureAt: 2000 }), /最近请求成功/);
  assert.match(aiHtml({ configured: true, callsLastHour: 600, maxCallsPerHour: 600 }), /额度已用尽/);
  assert.match(aiHtml({ averageLatencyMs: null }), /暂无/);
  assert.match(aiHtml({ successes: 3, failures: 1, cancellations: 2 }), /本次运行/);
  assert.match(summaryHtml(snapshot()), /1 桌等待 · 1 桌游戏中/);
  assert.equal(durationLabel(90061000), '1 天 1 小时');
});

test('events render newest first with bounded history and safe level names', () => {
  const events = Array.from({ length: 45 }, (_, i) => ({ at: i + 1, message: `event-${i}`, level: 'bad class' }));
  const html = eventsHtml(events);
  assert.equal((html.match(/<li /g) || []).length, 40);
  assert.ok(html.indexOf('event-44') < html.indexOf('event-43'));
  assert.ok(!html.includes('event-0<'));
  assert.ok(!html.includes('bad class'));
  assert.match(eventsHtml([]), /暂无运行动态/);
});

test('unknown AI metrics are not reported as zero calls or zero failures', () => {
  const html = aiHtml({ configured: true, callsLastHour: null, maxCallsPerHour: 600, successes: null, cancellations: undefined, failures: null });
  assert.match(html, /— \/ 600/);
  assert.equal((html.match(/<strong>—<\/strong>/g) || []).length, 3);
  assert.ok(!html.includes('<progress'));
  assert.match(html, /额度数据暂不可用/);
  const zero = aiHtml({ callsLastHour: 0, maxCallsPerHour: 600, successes: 0, cancellations: 0, failures: 0 });
  assert.match(zero, /0 \/ 600/);
  assert.equal((zero.match(/<strong>0<\/strong>/g) || []).length, 3);
});

test('login sends token only in same-origin POST and starts authenticated polling', async () => {
  const h = harness(async url => response(url.endsWith('state') ? snapshot() : { authenticated: true }));
  assert.equal(await h.session.authenticate('test-secret-never-persist'), true);
  assert.equal(h.requests[0].url, './api/login');
  assert.equal(h.requests[0].options.method, 'POST');
  assert.equal(h.requests[0].options.credentials, 'same-origin');
  assert.equal(JSON.parse(h.requests[0].options.body).token, 'test-secret-never-persist');
  assert.ok(h.requests.every(r => !r.url.includes('secret')));
  assert.equal(h.session.state.snapshot.rooms.length, 2);
  assert.equal(h.session.state.updatedAt, 123456);
  assert.equal([...h.timers.values()].filter(t => t.ms === 5000).length, 1);
  assert.ok(!JSON.stringify(h.session.state).includes('test-secret'));
  h.session.dispose();
});

test('unauthenticated session probe stays at login without polling or warning', async () => {
  const h = harness(async () => response({}, 401));
  assert.equal(await h.session.authenticate(), false);
  assert.equal(h.session.state.authenticated, false);
  assert.equal(h.session.state.error, '');
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, 1);
});

test('incorrect login and rate limiting expose fixed safe errors', async () => {
  for (const [status, message] of [[401, /口令不正确/], [429, /过于频繁/], [500, /无法连接/]]) {
    const h = harness(async () => response({ error: 'SECRET_INTERNAL_ERROR' }, status));
    await h.session.authenticate('x');
    assert.match(h.session.state.error, message);
    assert.ok(!h.session.state.error.includes('SECRET'));
    assert.equal(h.session.state.busy, false);
    assert.equal(h.timers.size, 0);
  }
});

test('hidden page cancels state request and old success cannot replace visible refresh', async () => {
  const first = deferred(); let stateCalls = 0;
  const h = harness(url => url.endsWith('state') ? (++stateCalls === 1 ? first.promise : Promise.resolve(response(snapshot({ version: 'current' })))) : Promise.resolve(response({ authenticated: true })));
  const auth = h.session.authenticate(); await settle();
  assert.equal(h.session.state.authenticated, true);
  const oldSignal = h.requests[1].options.signal;
  h.session.setVisible(false);
  assert.equal(oldSignal.aborted, true);
  assert.equal([...h.timers.values()].filter(t => t.ms === 5000).length, 0);
  h.session.setVisible(true); await settle();
  assert.equal(h.session.state.snapshot.version, 'current');
  first.resolve(response(snapshot({ version: 'old' }))); await auth;
  assert.equal(h.session.state.snapshot.version, 'current');
  h.session.dispose();
});

test('failed polling retains prior data with stale state; recovery clears warning', async () => {
  let broken = false;
  const h = harness(async url => url.endsWith('state') ? broken ? response({}, 503) : response(snapshot()) : response({ authenticated: true }));
  await h.session.authenticate(); const initial = h.session.state.snapshot;
  broken = true; await h.session.refresh();
  assert.equal(h.session.state.snapshot, initial);
  assert.equal(h.session.state.stale, true);
  assert.match(h.session.state.error, /保留上次数据/);
  assert.equal([...h.timers.values()].filter(t => t.ms === 5000).length, 1);
  broken = false; await h.session.refresh();
  assert.equal(h.session.state.stale, false);
  assert.equal(h.session.state.error, '');
  h.session.dispose();
});

test('expired session clears every privileged field and stops polling', async () => {
  let expired = false;
  const h = harness(async url => url.endsWith('state') ? expired ? response({}, 401) : response(snapshot()) : response({ authenticated: true }));
  await h.session.authenticate(); expired = true; await h.session.refresh();
  assert.equal(h.session.state.authenticated, false);
  assert.equal(h.session.state.snapshot, null);
  assert.equal(h.session.state.updatedAt, null);
  assert.match(h.session.state.error, /会话已失效/);
  assert.equal(h.timers.size, 0);
});

test('logout immediately clears data and ignores in-flight results even without transport abort', async () => {
  const late = deferred(); let stateCalls = 0;
  const h = harness(async url => url.endsWith('state') ? (++stateCalls === 1 ? response(snapshot()) : late.promise) : response({ authenticated: !url.endsWith('logout') }));
  await h.session.authenticate();
  const updating = h.session.refresh();
  await h.session.logout();
  assert.equal(h.session.state.snapshot, null);
  assert.equal(h.session.state.authenticated, false);
  late.resolve(response(snapshot({ version: 'late' }))); await updating;
  assert.equal(h.session.state.snapshot, null);
  assert.equal(h.session.state.authenticated, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.at(-1).options.method, 'POST');
});

test('manual refresh cannot overlap an in-flight request', async () => {
  const late = deferred();
  const h = harness(async url => url.endsWith('state') ? late.promise : response({ authenticated: true }));
  const auth = h.session.authenticate(); await settle();
  await h.session.refresh(); await h.session.refresh();
  assert.equal(h.requests.filter(r => r.url.endsWith('state')).length, 1);
  late.resolve(response(snapshot())); await auth;
  h.session.dispose();
});

test('logout failure reports remaining server-session uncertainty without restoring data', async () => {
  const h = harness(async url => url.endsWith('logout') ? response({}, 503) : response(url.endsWith('state') ? snapshot() : { authenticated: true }));
  await h.session.authenticate(); await h.session.logout();
  assert.equal(h.session.state.snapshot, null);
  assert.equal(h.session.state.authenticated, false);
  assert.match(h.session.state.error, /退出请求未送达/);
  assert.equal(h.timers.size, 0);
});

test('browser shell has external CSP-compatible assets and no credential storage', async () => {
  const [html, js, css] = await Promise.all(['index.html', 'main.js', 'style.css'].map(name => readFile(new URL(`../admin/${name}`, import.meta.url), 'utf8')));
  assert.match(html, /type="password"/);
  assert.match(html, /type="module" src="\.\/main.js"/);
  assert.ok(!html.match(/style=|onclick=|<script(?![^>]*src=)/));
  assert.ok(!js.match(/localStorage|sessionStorage|location\.search|document\.cookie|console\./));
  assert.match(js, /visibilitychange/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(html, /<label for="token">管理口令/);
});
