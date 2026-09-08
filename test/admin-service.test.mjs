import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import WebSocket from 'ws';
import { createService } from '../server/service.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const token = 'local-test-only-'.padEnd(43, 'x');
const origin = 'http://127.0.0.1:8790';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t, enabled = true) {
  const provider = { decide: () => new Promise(() => {}), chat: async () => ({ text: 'PRIVATE_CHAT_RESPONSE' }),
    getMetrics: () => ({ model: 'test-only', callsLastHour: 1, maxCallsPerHour: 600, successes: 1, failures: 0, cancellations: 0, inFlight: 0, averageLatencyMs: 10, lastSuccessAt: 100, lastFailureAt: null }) };
  const service = createService({ root, provider, random: () => 0.99, admin: enabled ? { origin, tokenHash: createHash('sha256').update(token).digest('hex') } : null });
  const address = await service.listen(0); t.after(() => service.close());
  const base = `http://127.0.0.1:${address.port}`;
  const request = (pathname, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method: options.method || 'GET', headers: { Host: '127.0.0.1:8790', Origin: origin, ...options.headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    }); req.on('error', reject); req.end(options.body);
  });
  const api = (name, options = {}) => request('/werewolf/admin/api/' + name, options);
  const login = await api('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  return { service, base, api, request, cookie: login.headers.get('set-cookie')?.split(';')[0] };
}
async function seated(base) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/werewolf/ws');
  const peer = { ws, messages: [], send: value => ws.send(JSON.stringify(value)) };
  ws.on('message', raw => peer.messages.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  peer.wait = async predicate => {
    const end = Date.now() + 4000;
    while (Date.now() < end) { const message = peer.messages.find(predicate); if (message) return message; await sleep(5); }
    throw Error('Timed out waiting for test room');
  };
  peer.send({ type: 'create', name: '监控联测玩家' });
  peer.welcome = await peer.wait(message => message.type === 'welcome');
  return peer;
}

test('integrated admin sees live room lifecycle without joining a seat or leaking private game data', async t => {
  const { service, base, api, cookie } = await setup(t);
  assert.ok(cookie);
  const unauth = await api('state'); assert.equal(unauth.status, 401);
  const peer = await seated(base); const roomId = peer.welcome.roomId;
  peer.send({ type: 'lobby_chat', text: 'PRIVATE_CHAT_QUESTION' });
  await peer.wait(m => m.state?.lobbyChat?.messages.some(message => message.kind === 'agent'));
  const getState = async () => { const response = await api('state', { headers: { Cookie: cookie } }); assert.equal(response.status, 200); return response.json(); };
  let state = await getState();
  assert.equal(state.summary.onlineHumans, 1); assert.equal(state.summary.rooms, 1);
  assert.equal(state.rooms[0].roomId, roomId); assert.equal(state.rooms[0].players[0].name, '监控联测玩家');
  assert.equal(state.rooms[0].phase, 'lobby'); assert.equal(state.ai.successes, 1);
  assert.ok(state.events.some(event => event.kind === 'room_created'));
  assert.ok(state.events.some(event => event.kind === 'admin_login'));
  peer.send({ type: 'start' }); await peer.wait(m => m.state?.phase === 'night');
  state = await getState();
  assert.equal(state.rooms[0].phase, 'night'); assert.equal(state.rooms[0].bots, 5);
  assert.equal(state.rooms[0].deadline, null); assert.equal(state.summary.activeRooms, 1);
  const serialized = JSON.stringify(state);
  for (const secret of ['PRIVATE_CHAT_', peer.welcome.playerId, peer.welcome.resumeToken, token, '"role":', '"clues":']) assert.ok(!serialized.includes(secret));
  assert.equal(service.rooms.get(roomId).game.players.length, 6);
  peer.ws.close();
  const deadline = Date.now() + 3000;
  do { state = await getState(); if (state.summary.onlineHumans === 0) break; await sleep(10); } while (Date.now() < deadline);
  assert.equal(state.summary.pausedRooms, 1); assert.equal(state.rooms[0].paused, true);
  assert.ok(state.events.some(event => event.kind === 'room_paused'));
  const logout = await api('logout', { method: 'POST', headers: { Cookie: cookie } }); assert.equal(logout.status, 200);
  assert.equal((await api('state', { headers: { Cookie: cookie } })).status, 401);
});

test('disabled admin has no route and enabled admin has no state-changing game endpoint', async t => {
  const disabled = await setup(t, false);
  assert.equal((await disabled.api('state')).status, 404);
  const enabled = await setup(t);
  assert.equal((await enabled.api('rooms/0001/close', { method: 'POST', headers: { Cookie: enabled.cookie } })).status, 404);
  for (const path of ['/admin/index.html', '/werewolf/admin/token', '/werewolf/private-admin-access.txt', '/werewolf/server/admin.mjs']) {
    const response = await enabled.request(path);
    assert.equal(response.status, 404, path);
  }
  assert.equal((await fetch(enabled.base + '/werewolf/health')).status, 200);
});
