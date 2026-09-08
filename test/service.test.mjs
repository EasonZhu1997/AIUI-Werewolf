import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createService } from '../server/service.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function client(url, options) {
  const ws = new WebSocket(url); const inbox = [];
  ws.on('message', data => inbox.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const send = message => ws.send(JSON.stringify(message));
  const wait = async predicate => {
    const end = Date.now() + 4000;
    while (Date.now() < end) { const found = inbox.find(predicate); if (found) return found; await pause(10); }
    throw new Error('Timed out waiting for server message');
  };
  send({ type: 'join', ...options });
  return { ws, inbox, send, wait, get state() { return inbox.filter(m => m.type === 'state').at(-1)?.state; } };
}
async function setup(t, provider = { decide: () => new Promise(() => {}) }) {
  const service = createService({ root, provider, random: () => 0.99 });
  const address = await service.listen(0); const base = `http://127.0.0.1:${address.port}`;
  t.after(() => service.close());
  return { service, base, url: base.replace('http:', 'ws:') + '/werewolf/ws' };
}
test('six human seats, seventh rejected, room isolation and private role views', async t => {
  const { url } = await setup(t);
  const peers = [];
  for (let i = 0; i < 6; i++) { const c = await client(url, { roomId: '0037', name: `P${i}` }); await c.wait(m => m.type === 'state'); peers.push(c); }
  const seventh = await client(url, { roomId: '0037', name: 'extra' });
  assert.match((await seventh.wait(m => m.type === 'error')).message, /六人|已满/);
  const other = await client(url, { roomId: 'lobby', name: 'other' }); await other.wait(m => m.type === 'state');
  peers[0].send({ type: 'start' });
  await peers[0].wait(m => m.type === 'state' && m.state.phase === 'night');
  await pause(20);
  for (const peer of peers) {
    const state = peer.state;
    assert.equal(state.players.filter(p => p.role).length, 1);
    assert.equal(state.players.find(p => p.role).id, state.selfId);
    assert.ok(!JSON.stringify(peer.inbox).includes('DEEPSEEK'));
  }
  assert.equal(other.state.phase, 'lobby'); assert.equal(other.state.players.length, 1);
});
test('resume requires secret token and replaces old socket without disconnecting resumed seat', async t => {
  const { url } = await setup(t);
  const a = await client(url, { roomId: '1234', name: 'one' });
  const welcome = await a.wait(m => m.type === 'welcome'); await a.wait(m => m.type === 'state');
  const b = await client(url, { roomId: '1234', resumeToken: welcome.resumeToken });
  await b.wait(m => m.type === 'state'); await pause(30);
  assert.equal(b.state.selfId, welcome.playerId);
  assert.equal(b.state.players.filter(p => !p.bot).length, 1);
  assert.equal(b.state.players[0].connected, true);
  const attacker = await client(url, { roomId: '1234', resumeToken: 'invalid' });
  assert.equal((await attacker.wait(m => m.type === 'error')).code, 'RESUME_EXPIRED');
});
test('every seated human may start while stale revisions remain rejected', async t => {
  const { url } = await setup(t);
  const a = await client(url, { roomId: '2468', name: 'one' }); await a.wait(m => m.type === 'state');
  const b = await client(url, { roomId: '2468', name: 'two' }); await b.wait(m => m.type === 'state');
  b.send({ type: 'start', playerId: a.state.selfId });
  await a.wait(m => m.type === 'state' && m.state.phase === 'night');
  a.send({ type: 'action', revision: -1, action: { kind: 'night', action: 'kill', target: 3 } });
  assert.match((await a.wait(m => m.type === 'error')).message, /更新/);
});
test('HTTP public files do not expose server code, private config, environment or package inputs', async t => {
  const { base } = await setup(t);
  for (const pathname of ['/private-config.json', '/server/provider.mjs', '/.env', '/package.json', '/werewolf/private-config.json', '/lib/../../private-config.json']) {
    assert.equal((await fetch(base + pathname)).status, 404, pathname);
  }
  const health = await (await fetch(base + '/werewolf/health')).json();
  assert.equal(health.maxPlayers, 6);
  const config = await (await fetch(base + '/lib/config.js')).text();
  assert.ok(!config.includes('/Users/')); assert.ok(!config.includes('apiKey'));
});
test('cross-origin browser WebSocket rejected', async t => {
  const { url } = await setup(t);
  const ws = new WebSocket(url, { origin: 'https://unrelated.example' });
  const error = await new Promise(resolve => { ws.on('error', resolve); ws.on('open', () => resolve(null)); });
  assert.ok(error);
});

test('explicit localhost preview origin can connect without enabling arbitrary cross-origin access', async t => {
  const service = createService({ root, previewOrigins: ['http://127.0.0.1:51794'] });
  const address = await service.listen(0); t.after(() => service.close());
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/werewolf/ws`, { origin: 'http://127.0.0.1:51794' });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.close();
  assert.throws(() => createService({ root, previewOrigins: ['https://outside.example'] }), /本机/);
});
