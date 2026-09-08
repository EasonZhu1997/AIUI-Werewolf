import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createService } from '../server/service.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, message = 'condition', timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = predicate(); if (result) return result; await pause(5); }
  throw new Error(`Timed out: ${message}`);
}
async function setup(t, options = {}) {
  const service = createService({ root: projectRoot, random: () => 0.999, aiRetryDelayMs: 1, ...options });
  const address = await service.listen(0);
  t.after(() => service.close());
  const base = `http://127.0.0.1:${address.port}`;
  return { service, base, url: base.replace('http:', 'ws:') + '/werewolf/ws' };
}
async function connect(url, join) {
  const ws = new WebSocket(url);
  const inbox = [];
  ws.on('message', data => inbox.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = message => ws.send(JSON.stringify(message));
  send({ type: 'join', ...join });
  const c = { ws, inbox, send,
    wait: predicate => eventually(() => inbox.find(predicate), 'WebSocket message'),
    get state() { return inbox.filter(m => m.type === 'state').at(-1)?.state; },
  };
  return c;
}
const allSkip = pending => pending.kind === 'speech' ? { kind: 'speech', text: `${pending.context.selfSeat}号发言：我会根据大家的发言继续判断。` } : { kind: pending.kind, action: 'skip', target: null };
function deferredProvider() {
  const calls = [];
  return { calls, decide(pending, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const call = { pending, resolve, reject, signal }; calls.push(call);
      signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  } };
}

test('night broadcasts never disclose which hidden role bot is thinking', async t => {
  const provider = deferredProvider();
  const { url } = await setup(t, { provider });
  const human = await connect(url, { roomId: '1300', name: '玩家' });
  await human.wait(m => m.type === 'state'); human.send({ type: 'start' });
  await eventually(() => provider.calls.length === 1);
  await eventually(() => human.state?.aiStatus);
  assert.equal(human.state.aiStatus, 'AI 正在处理夜晚行动');
  assert.doesNotMatch(human.state.aiStatus, /\d|狼|女巫|预言家/);
  assert.equal(human.state.players.filter(p => p.role).length, 1);
});

test('human private action during AI request preserves the existing bot call and result', async t => {
  const provider = deferredProvider();
  const { service, url } = await setup(t, { provider });
  const human = await connect(url, { roomId: '1301', name: '玩家' });
  await human.wait(m => m.type === 'state'); human.send({ type: 'start' });
  await eventually(() => provider.calls.length === 1);
  await eventually(() => human.state?.phase === 'night');
  const oldRevision = provider.calls[0].pending.revision;
  human.send({ type: 'action', revision: human.state.revision, action: { kind: 'night', action: 'kill', target: 5 } });
  await eventually(() => service.rooms.get('1301').game.revision > oldRevision);
  provider.calls[0].resolve({ kind: 'night', action: 'kill', target: 5 });
  await eventually(() => provider.calls.length === 2);
  assert.equal(provider.calls[0].pending.context.selfSeat, 2);
  assert.equal(provider.calls[1].pending.context.selfSeat, 3, 'next paid call must be seer, not a repeated wolf request');
});

test('all-human disconnect freezes remaining deadline, aborts the request, and resumes the seat', async t => {
  let now = 1000;
  const provider = deferredProvider();
  const { service, url } = await setup(t, { provider, now: () => now, durations: { night: 10000 } });
  const human = await connect(url, { roomId: '1302', name: '玩家' });
  const welcome = await human.wait(m => m.type === 'welcome');
  await human.wait(m => m.type === 'state'); human.send({ type: 'start' });
  await eventually(() => provider.calls.length === 1);
  const deadline = service.rooms.get('1302').game.deadline;
  now += 2500;
  human.ws.close();
  await eventually(() => service.rooms.get('1302').sockets.size === 0);
  await eventually(() => provider.calls[0].signal.aborted);
  now += 60000;
  await pause(320);
  assert.equal(provider.calls.length, 1);
  assert.equal(service.rooms.get('1302').game.phase, 'night');
  const resumed = await connect(url, { roomId: '1302', resumeToken: welcome.resumeToken });
  await resumed.wait(m => m.type === 'state');
  assert.equal(resumed.state.selfId, welcome.playerId);
  assert.equal(resumed.state.deadline, deadline + 60000);
  assert.equal(resumed.state.deadline - now, 7500);
  await eventually(() => provider.calls.length === 2);
  assert.equal(provider.calls[1].pending.playerId, provider.calls[0].pending.playerId);
});

test('phase expiry aborts an obsolete model request before it can act or retry', async t => {
  let now = 1000;
  const provider = deferredProvider();
  const { service, url } = await setup(t, { provider, now: () => now, durations: { night: 10000 } });
  const human = await connect(url, { roomId: '1310', name: '玩家' });
  await human.wait(m => m.type === 'state'); human.send({ type: 'start' });
  await eventually(() => provider.calls.length === 1);
  now = service.rooms.get('1310').game.deadline;
  await eventually(() => provider.calls[0].signal.aborted);
  await eventually(() => provider.calls.length === 2);
  assert.equal(provider.calls[1].pending.context.selfSeat, 3);
  provider.calls[0].resolve({ kind: 'night', action: 'kill', target: 5 });
  await pause(10);
  assert.equal(service.rooms.get('1310').game.players.every(p => p.alive), true);
  assert.equal(provider.calls.length, 2);
});

test('active-game leave can resume, lobby leave invalidates token, and tokens cannot cross rooms', async t => {
  const { url } = await setup(t, { provider: deferredProvider() });
  const a = await connect(url, { roomId: '1303', name: '玩家' });
  const welcome = await a.wait(m => m.type === 'welcome'); await a.wait(m => m.type === 'state');
  const wrong = await connect(url, { roomId: '1304', resumeToken: welcome.resumeToken });
  assert.equal((await wrong.wait(m => m.type === 'error')).code, 'RESUME_EXPIRED');
  a.send({ type: 'start' }); await a.wait(m => m.type === 'state' && m.state.phase === 'night');
  a.send({ type: 'leave' }); await eventually(() => a.ws.readyState === WebSocket.CLOSED);
  const resumed = await connect(url, { roomId: '1303', resumeToken: welcome.resumeToken });
  assert.equal((await resumed.wait(m => m.type === 'welcome')).playerId, welcome.playerId);
  const lobby = await connect(url, { roomId: '1305', name: '访客' });
  const lobbyWelcome = await lobby.wait(m => m.type === 'welcome'); await lobby.wait(m => m.type === 'state');
  lobby.send({ type: 'leave' }); await eventually(() => lobby.ws.readyState === WebSocket.CLOSED);
  const expired = await connect(url, { roomId: '1305', resumeToken: lobbyWelcome.resumeToken });
  assert.equal((await expired.wait(m => m.type === 'error')).code, 'RESUME_EXPIRED');
});

test('empty rooms expire and reconnect credentials expire with them', async t => {
  let now = 0;
  const { service, url } = await setup(t, { provider: deferredProvider(), now: () => now, maxRooms: 1 });
  const a = await connect(url, { roomId: '1306', name: '玩家' });
  const welcome = await a.wait(m => m.type === 'welcome'); await a.wait(m => m.type === 'state');
  const full = await connect(url, { roomId: '1307', name: '玩家' });
  assert.match((await full.wait(m => m.type === 'error')).message, /房间较多/);
  a.ws.close(); await eventually(() => service.rooms.get('1306').sockets.size === 0);
  now = 30 * 60 * 1000 + 1;
  await eventually(() => !service.rooms.has('1306'));
  const expired = await connect(url, { roomId: '1306', resumeToken: welcome.resumeToken });
  assert.equal((await expired.wait(m => m.type === 'error')).code, 'RESUME_EXPIRED');
  const fresh = await connect(url, { roomId: '1307', name: '新玩家' });
  await fresh.wait(m => m.type === 'welcome');
});

test('public file server denies a parent-directory symlink into private files', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-http-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'public'); const secret = path.join(temp, 'private');
  fs.mkdirSync(root); fs.mkdirSync(secret); fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(secret, 'secret.js'), 'PRIVATE_SENTINEL');
  fs.symlinkSync(secret, path.join(root, 'assets', 'shortcut'));
  const { base } = await setup(t, { root });
  const response = await fetch(base + '/assets/shortcut/secret.js');
  assert.equal(response.status, 404);
  assert.ok(!(await response.text()).includes('PRIVATE_SENTINEL'));
});

test('single human and deterministic test bots complete a full game over real WebSockets', async t => {
  const calls = [];
  const provider = { async decide(pending) {
    calls.push(pending); await pause(5);
    if (pending.kind === 'speech') return allSkip(pending);
    const choice = pending.kind === 'night' ? pending.choices.find(c => c.action === 'kill' && c.target === 5) : pending.choices.find(c => c.action === 'vote' && c.target === 6);
    return choice ? { kind: pending.kind, action: choice.action, target: choice.target } : allSkip(pending);
  } };
  const { url } = await setup(t, { provider });
  const human = await connect(url, { roomId: '1308', name: '玩家' });
  await human.wait(m => m.type === 'state');
  const submitted = new Set(); const heard = new Set();
  human.ws.on('message', raw => {
    const msg = JSON.parse(raw); if (msg.type !== 'state') return;
    const state = msg.state;
    if (state.phase === 'playback' && state.speech && !heard.has(state.speech.id)) {
      heard.add(state.speech.id); human.send({ type: 'speech_done', speechId: state.speech.id });
    }
    if (!state.prompt || submitted.has(state.revision)) return;
    submitted.add(state.revision);
    const pending = { kind: state.prompt.kind, choices: state.prompt.choices, context: state };
    let action;
    if (pending.kind === 'speech') action = { kind: 'speech', text: '1号发言：我想听听其他玩家的推理。' };
    else {
      const choice = pending.choices.find(c => c.action === (pending.kind === 'night' ? 'kill' : 'vote') && c.target === (pending.kind === 'night' ? 5 : 6));
      action = choice ? { kind: pending.kind, action: choice.action, target: choice.target } : allSkip(pending);
    }
    human.send({ type: 'action', revision: state.revision, action });
  });
  human.send({ type: 'start' });
  const final = await human.wait(m => m.type === 'state' && m.state.phase === 'result');
  assert.equal(final.state.result.winner, 'wolves');
  assert.equal(final.state.players.length, 6);
  assert.equal(final.state.players.filter(p => p.bot).length, 5);
  assert.equal(heard.size, 5);
  assert.equal(calls.filter(p => p.kind === 'speech').length, 4);
  assert.ok(final.state.logs.some(l => l.text.includes('1号发言')));
  for (const pending of calls) assert.deepEqual(pending.context.players.filter(p => p.role).map(p => p.id), [pending.playerId]);
  human.send({ type: 'restart' });
  await eventually(() => human.state?.phase === 'lobby');
  assert.equal(human.state.players.length, 1);
  assert.equal(human.state.self, null);
});

test('playback waits for every connected human; stale acks do not advance the next speech', async t => {
  const { service, url } = await setup(t, { provider: { async decide(pending) { await pause(3); return allSkip(pending); } } });
  const a = await connect(url, { roomId: '1309', name: '甲' }); await a.wait(m => m.type === 'state');
  const b = await connect(url, { roomId: '1309', name: '乙' }); await b.wait(m => m.type === 'state');
  a.send({ type: 'start' }); await eventually(() => a.state?.prompt?.kind === 'night');
  const firstNightRevision = a.state.revision;
  a.send({ type: 'action', revision: a.state.revision, action: { kind: 'night', action: 'skip', target: null } });
  await eventually(() => b.state?.prompt?.kind === 'night' && b.state.revision > firstNightRevision);
  b.send({ type: 'action', revision: b.state.revision, action: { kind: 'night', action: 'skip', target: null } });
  await eventually(() => a.state?.prompt?.kind === 'speech');
  a.send({ type: 'action', revision: a.state.revision, action: { kind: 'speech', text: '甲的公开发言' } });
  await eventually(() => a.state?.phase === 'playback');
  const first = a.state.speech.id;
  a.send({ type: 'speech_done', speechId: first }); await pause(20);
  assert.equal(service.rooms.get('1309').game.phase, 'playback');
  b.send({ type: 'speech_done', speechId: first });
  await eventually(() => b.state?.prompt?.kind === 'speech');
  b.send({ type: 'action', revision: b.state.revision, action: { kind: 'speech', text: '乙的公开发言' } });
  await eventually(() => b.state?.phase === 'playback' && b.state.speech.id !== first);
  const second = b.state.speech.id;
  a.send({ type: 'speech_done', speechId: first }); b.send({ type: 'speech_done', speechId: first });
  await pause(20);
  assert.equal(service.rooms.get('1309').game.speech.id, second);
  a.send({ type: 'speech_done', speechId: second });
  b.ws.close();
  await eventually(() => service.rooms.get('1309').game.speech?.id !== second);
});
