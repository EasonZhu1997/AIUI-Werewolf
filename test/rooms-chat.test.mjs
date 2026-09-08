import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createService } from '../server/service.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label = 'state') {
  const end = Date.now() + 3500;
  while (Date.now() < end) { const found = predicate(); if (found) return found; await pause(5); }
  throw new Error('Timed out: ' + label);
}
async function setup(t, options = {}) {
  const service = createService({ root, random: () => 0.999, provider: { decide: () => new Promise(() => {}), chat: async () => ({ text: '我是小月，欢迎来到同桌。' }) }, ...options });
  const address = await service.listen(0); t.after(() => service.close());
  return { service, url: `ws://127.0.0.1:${address.port}/werewolf/ws` };
}
async function client(url, initial) {
  const ws = new WebSocket(url); const inbox = [];
  ws.on('message', raw => inbox.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = { ws, inbox, send: data => ws.send(JSON.stringify(data)),
    wait: predicate => until(() => inbox.find(predicate), 'message'),
    get state() { return inbox.filter(m => m.type === 'state').at(-1)?.state; },
    get directory() { return inbox.filter(m => m.type === 'rooms').at(-1)?.rooms; },
    get welcome() { return inbox.find(m => m.type === 'welcome'); },
  };
  if (initial) c.send(initial);
  return c;
}
function delayedChat() {
  const calls = [];
  return { calls, decide: () => new Promise(() => {}), chat: (history, { signal }) => new Promise((resolve, reject) => {
    calls.push({ history, signal, resolve, reject });
  }) };
}

test('server allocates unique four-digit rooms and includes the authoritative room in every welcome', async t => {
  const { service, url } = await setup(t);
  const a = await client(url, { type: 'create', name: '甲' });
  const aw = await a.wait(m => m.type === 'welcome');
  assert.match(aw.roomId, /^\d{4}$/); assert.ok(aw.playerId); assert.ok(aw.resumeToken);
  const b = await client(url, { type: 'create', name: '乙' });
  const bw = await b.wait(m => m.type === 'welcome');
  assert.notEqual(bw.roomId, aw.roomId);
  const friend = await client(url, { type: 'join', roomId: aw.roomId, createIfMissing: false, name: '朋友' });
  assert.equal((await friend.wait(m => m.type === 'welcome')).roomId, aw.roomId);
  await until(() => a.state?.players.length === 2);
  assert.equal(service.rooms.size, 2);
  assert.equal(a.state.canStart, true); assert.equal(friend.state.canStart, true);
});

test('strict joins fail without creating a room; legacy implicit joins and virtual lobby remain supported', async t => {
  const { service, url } = await setup(t);
  const strict = await client(url, { type: 'join', roomId: '0088', name: '甲', createIfMissing: false });
  assert.equal((await strict.wait(m => m.type === 'error')).code, 'ROOM_NOT_FOUND');
  assert.equal(service.rooms.has('0088'), false);
  const legacy = await client(url, { type: 'join', roomId: '0088', name: '旧客户端' });
  await legacy.wait(m => m.type === 'welcome'); assert.equal(service.rooms.has('0088'), true);
  const lobby = await client(url, { type: 'join', roomId: 'lobby', name: '大厅访客', createIfMissing: false });
  assert.equal((await lobby.wait(m => m.type === 'welcome')).roomId, 'lobby');
});

test('room directory subscription survives join timeout and reveals only bounded room metadata', async t => {
  const { url } = await setup(t, { joinTimeoutMs: 70 });
  const watch = await client(url, { type: 'rooms' });
  await until(() => watch.directory);
  assert.deepEqual(watch.directory, [{ roomId: 'lobby', phase: 'lobby', members: 0, online: 0, capacity: 6, canJoin: true }]);
  await pause(100); assert.equal(watch.ws.readyState, WebSocket.OPEN);
  const a = await client(url, { type: 'create', name: 'PRIVATE_NAME_NEVER_IN_DIRECTORY' });
  const welcome = await a.wait(m => m.type === 'welcome');
  await until(() => watch.directory?.some(row => row.roomId === welcome.roomId && row.online === 1));
  for (const row of watch.directory) assert.deepEqual(Object.keys(row).sort(), ['roomId', 'phase', 'members', 'online', 'capacity', 'canJoin'].sort());
  const listing = JSON.stringify(watch.directory);
  for (const privateValue of [welcome.playerId, welcome.resumeToken, 'PRIVATE_NAME_NEVER_IN_DIRECTORY']) assert.ok(!listing.includes(privateValue));
  a.send({ type: 'start' });
  await until(() => watch.directory?.some(row => row.roomId === welcome.roomId && row.phase === 'night' && row.canJoin === false));
  const row = watch.directory.find(row => row.roomId === welcome.roomId);
  assert.equal(row.members, 6); assert.equal(row.online, 1);
  a.ws.close();
  await until(() => watch.directory?.some(row => row.roomId === welcome.roomId && row.online === 0));
});

test('directory updates when abandoned rooms expire and the public lobby retains its reserved slot', async t => {
  let now = 0;
  const { service, url } = await setup(t, { now: () => now, maxRooms: 1 });
  const watch = await client(url, { type: 'rooms' }); await until(() => watch.directory);
  const a = await client(url, { type: 'create', name: '甲' });
  const welcome = await a.wait(m => m.type === 'welcome');
  const limit = await client(url, { type: 'create', name: '乙' });
  assert.match((await limit.wait(m => m.type === 'error')).message, /房间较多/);
  const lobby = await client(url, { type: 'join', roomId: 'lobby', name: '大厅', createIfMissing: false });
  await lobby.wait(m => m.type === 'welcome');
  a.ws.close(); await until(() => service.rooms.get(welcome.roomId).sockets.size === 0);
  now = 30 * 60 * 1000 + 1;
  await until(() => !service.rooms.has(welcome.roomId));
  await until(() => !watch.directory.some(row => row.roomId === welcome.roomId));
  assert.equal(watch.directory[0].roomId, 'lobby'); assert.equal(watch.directory[0].online, 1);
});

test('explicitly leaving the last waiting seat releases room capacity while plain disconnect remains resumable', async t => {
  const { service, url } = await setup(t, { maxRooms: 1 });
  const watch = await client(url, { type: 'rooms' }); await until(() => watch.directory);
  for (let i = 0; i < 3; i++) {
    const a = await client(url, { type: 'create', name: '重复创建' });
    const welcome = await a.wait(m => m.type === 'welcome'); await a.wait(m => m.type === 'state');
    await until(() => watch.directory.some(row => row.roomId === welcome.roomId));
    a.send({ type: 'leave' });
    await until(() => !service.rooms.has(welcome.roomId));
    await until(() => !watch.directory.some(row => row.roomId === welcome.roomId));
    assert.equal(service.rooms.size, 0);
  }
  const a = await client(url, { type: 'create', name: '保留座位' });
  const welcome = await a.wait(m => m.type === 'welcome'); await a.wait(m => m.type === 'state');
  a.ws.close(); await until(() => service.rooms.get(welcome.roomId).sockets.size === 0);
  assert.equal(service.rooms.has(welcome.roomId), true);
  const resumed = await client(url, { type: 'join', roomId: welcome.roomId, resumeToken: welcome.resumeToken, createIfMissing: false });
  assert.equal((await resumed.wait(m => m.type === 'welcome')).playerId, welcome.playerId);
});

test('directory subscriptions retain the connection cap and inbound rate limit', async t => {
  const { url } = await setup(t, { maxConnections: 1 });
  const watch = await client(url, { type: 'rooms' }); await until(() => watch.directory);
  const extra = new WebSocket(url);
  const rejected = await new Promise(resolve => { extra.once('error', () => resolve(true)); extra.once('open', () => resolve(false)); });
  assert.equal(rejected, true);
  for (let i = 0; i < 101; i++) watch.send({ type: 'rooms' });
  const close = await new Promise(resolve => watch.ws.once('close', (code) => resolve(code)));
  assert.equal(close, 1008);
});

test('unseated directory clients cannot start, restart, chat or forge a seated actor', async t => {
  const { url } = await setup(t);
  const seated = await client(url, { type: 'create', name: '甲' });
  const welcome = await seated.wait(m => m.type === 'welcome');
  const watch = await client(url, { type: 'rooms' }); await until(() => watch.directory);
  for (const type of ['start', 'restart', 'lobby_chat']) watch.send({ type, playerId: welcome.playerId, text: '伪造身份' });
  await until(() => watch.inbox.filter(m => m.type === 'error').length === 3);
  assert.equal(seated.state.phase, 'lobby');
});

test('lobby companion reply is room-visible, bounded, and independent of game seats, revision and speech barrier', async t => {
  const provider = delayedChat();
  const { service, url } = await setup(t, { provider });
  const a = await client(url, { type: 'create', name: '甲' }); const welcome = await a.wait(m => m.type === 'welcome');
  const b = await client(url, { type: 'join', roomId: welcome.roomId, name: '乙', createIfMissing: false });
  await until(() => a.state?.players.length === 2);
  const revision = a.state.revision;
  a.send({ type: 'lobby_chat', text: '  小月，你能介绍一下规则吗？  ' });
  await until(() => provider.calls.length === 1);
  await until(() => a.state.lobbyChat?.status === 'thinking' && b.state.lobbyChat?.status === 'thinking');
  const history = provider.calls[0].history;
  assert.deepEqual(Object.keys(history[0]).sort(), ['id', 'kind', 'name', 'text']);
  assert.equal(history[0].kind, 'human'); assert.equal(history[0].text, '小月，你能介绍一下规则吗？');
  assert.ok(!JSON.stringify(history).includes(welcome.resumeToken));
  assert.ok(!JSON.stringify(history).includes(welcome.playerId));
  history[0].text = 'provider cannot mutate canonical history';
  provider.calls[0].resolve({ text: '当然，我们可以一边等朋友，一边聊规则。' });
  await until(() => a.state.lobbyChat.messages.length === 2 && b.state.lobbyChat.messages.length === 2);
  assert.equal(a.state.lobbyChat.messages[0].text, '小月，你能介绍一下规则吗？');
  assert.deepEqual(a.state.lobbyChat, b.state.lobbyChat);
  assert.equal(a.state.lobbyChat.messages[1].kind, 'agent'); assert.equal(a.state.lobbyChat.messages[1].name, '小月');
  assert.equal(a.state.revision, revision); assert.equal(a.state.players.length, 2); assert.equal(a.state.speech, null);
  assert.equal(service.rooms.get(welcome.roomId).game.revision, revision);
});

test('chat histories and in-flight replies are isolated between rooms', async t => {
  const provider = delayedChat(); const { url } = await setup(t, { provider });
  const a = await client(url, { type: 'create', name: '甲' }); await a.wait(m => m.type === 'state');
  const b = await client(url, { type: 'create', name: '乙' }); await b.wait(m => m.type === 'state');
  a.send({ type: 'lobby_chat', text: 'ROOM_A_ONLY' }); b.send({ type: 'lobby_chat', text: 'ROOM_B_ONLY' });
  await until(() => provider.calls.length === 2);
  assert.equal(provider.calls[0].history.length, 1); assert.equal(provider.calls[1].history.length, 1);
  const aCall = provider.calls.find(call => call.history[0].text === 'ROOM_A_ONLY');
  const bCall = provider.calls.find(call => call.history[0].text === 'ROOM_B_ONLY');
  aCall.resolve({ text: 'A_REPLY_ONLY' }); bCall.resolve({ text: 'B_REPLY_ONLY' });
  await until(() => a.state.lobbyChat?.messages.length === 2 && b.state.lobbyChat?.messages.length === 2);
  assert.ok(!JSON.stringify(a.state.lobbyChat).includes('B_')); assert.ok(!JSON.stringify(b.state.lobbyChat).includes('A_'));
});

test('recycling the same room number invalidates old credentials and isolates late companion replies', async t => {
  const provider = delayedChat(); const { service, url } = await setup(t, { provider, maxRooms: 1 });
  const a = await client(url, { type: 'join', roomId: '0421', name: '旧房玩家' });
  const oldWelcome = await a.wait(m => m.type === 'welcome'); await a.wait(m => m.type === 'state');
  a.send({ type: 'lobby_chat', text: 'OLD_ROOM_HISTORY' }); await until(() => provider.calls.length === 1);
  a.send({ type: 'leave' }); await until(() => !service.rooms.has('0421'));
  assert.equal(provider.calls[0].signal.aborted, true);

  const b = await client(url, { type: 'join', roomId: '0421', name: '新房玩家' });
  const newWelcome = await b.wait(m => m.type === 'welcome'); await b.wait(m => m.type === 'state');
  assert.notEqual(newWelcome.playerId, oldWelcome.playerId);
  assert.deepEqual(b.state.lobbyChat.messages, []);
  const stale = await client(url, { type: 'join', roomId: '0421', resumeToken: oldWelcome.resumeToken });
  assert.equal((await stale.wait(m => m.type === 'error')).code, 'RESUME_EXPIRED');

  b.send({ type: 'lobby_chat', text: 'NEW_ROOM_HISTORY' }); await until(() => provider.calls.length === 2);
  provider.calls[0].resolve({ text: 'OLD_ROOM_LATE_REPLY' });
  provider.calls[1].resolve({ text: 'NEW_ROOM_REPLY' });
  await until(() => b.state.lobbyChat.messages.length === 2);
  assert.deepEqual(b.state.lobbyChat.messages.map(message => message.text), ['NEW_ROOM_HISTORY', 'NEW_ROOM_REPLY']);
  assert.ok(!JSON.stringify(b.inbox).includes('OLD_ROOM'));

  b.ws.close(); await until(() => service.rooms.get('0421').sockets.size === 0);
  const resumed = await client(url, { type: 'join', roomId: '0421', resumeToken: newWelcome.resumeToken });
  assert.equal((await resumed.wait(m => m.type === 'welcome')).playerId, newWelcome.playerId);
});

test('non-host can start immediately during companion request; old reply is discarded and chat is cleared', async t => {
  const provider = delayedChat(); const { url } = await setup(t, { provider });
  const a = await client(url, { type: 'create', name: '甲' }); const welcome = await a.wait(m => m.type === 'welcome');
  const b = await client(url, { type: 'join', roomId: welcome.roomId, name: '乙', createIfMissing: false });
  await b.wait(m => m.type === 'state'); assert.notEqual(b.state.selfId, b.state.hostId); assert.equal(b.state.canStart, true);
  a.send({ type: 'lobby_chat', text: '小月，在吗' }); await until(() => provider.calls.length === 1);
  b.send({ type: 'start' }); await until(() => a.state?.phase === 'night' && b.state?.phase === 'night');
  assert.equal(provider.calls[0].signal.aborted, true);
  assert.equal(a.state.lobbyChat, null);
  provider.calls[0].resolve({ text: 'LATE_RESPONSE_MUST_DISAPPEAR' }); await pause(20);
  assert.ok(!JSON.stringify(a.inbox).includes('LATE_RESPONSE_MUST_DISAPPEAR'));
  a.send({ type: 'lobby_chat', text: '开局后不能陪聊' });
  assert.match((await a.wait(m => m.type === 'error')).message, /等待开局/);
});

test('all-human disconnect aborts companion request and a reconnect cannot receive its late reply', async t => {
  const provider = delayedChat(); const { service, url } = await setup(t, { provider });
  const a = await client(url, { type: 'create', name: '甲' }); const welcome = await a.wait(m => m.type === 'welcome');
  await a.wait(m => m.type === 'state'); a.send({ type: 'lobby_chat', text: '离线之前' });
  await until(() => provider.calls.length === 1); a.ws.close();
  await until(() => service.rooms.get(welcome.roomId).sockets.size === 0);
  assert.equal(provider.calls[0].signal.aborted, true);
  const resumed = await client(url, { type: 'join', roomId: welcome.roomId, resumeToken: welcome.resumeToken, createIfMissing: false });
  await resumed.wait(m => m.type === 'state');
  provider.calls[0].resolve({ text: 'LATE_OFFLINE_REPLY' }); await pause(20);
  assert.equal(resumed.state.lobbyChat.status, 'idle');
  assert.equal(resumed.state.lobbyChat.messages.length, 1);
  assert.ok(!JSON.stringify(resumed.inbox).includes('LATE_OFFLINE_REPLY'));
});

test('companion input checks, single flight, cooldown and fixed safe error permit a later retry', async t => {
  let now = 1000; const provider = delayedChat();
  const { url } = await setup(t, { provider, now: () => now });
  const a = await client(url, { type: 'create', name: '甲' }); await a.wait(m => m.type === 'state');
  for (const text of ['', '字'.repeat(241), { bad: true }]) a.send({ type: 'lobby_chat', text });
  await until(() => a.inbox.filter(m => m.type === 'error').length === 3); assert.equal(provider.calls.length, 0);
  a.send({ type: 'lobby_chat', text: '有效问题' }); await until(() => provider.calls.length === 1);
  a.send({ type: 'lobby_chat', text: '重复问题' }); await a.wait(m => m.type === 'error' && /正在回复/.test(m.message));
  provider.calls[0].reject(new Error('SECRET_PROVIDER_BODY_AND_KEY'));
  await until(() => a.state.lobbyChat.status === 'error');
  assert.equal(a.state.lobbyChat.error, '小月暂时无法回应，请稍后再试。');
  assert.ok(!JSON.stringify(a.inbox).includes('SECRET_PROVIDER'));
  a.send({ type: 'lobby_chat', text: '太快重试' }); await a.wait(m => m.type === 'error' && /稍候再发/.test(m.message));
  now += 2000;
  a.send({ type: 'lobby_chat', text: '再次询问' }); await until(() => provider.calls.length === 2);
  provider.calls[1].resolve({ text: '这次可以继续聊天了。' });
  await until(() => a.state.lobbyChat.status === 'idle' && a.state.lobbyChat.messages.some(m => m.kind === 'agent'));
});

test('companion timeout releases single-flight slot, rejects late result, and bounds history to twenty entries', async t => {
  const provider = delayedChat(); const { url } = await setup(t, { provider, lobbyChatTimeoutMs: 60, lobbyChatCooldownMs: 0 });
  const a = await client(url, { type: 'create', name: '甲' }); await a.wait(m => m.type === 'state');
  a.send({ type: 'lobby_chat', text: '会超时的问题' }); await until(() => provider.calls.length === 1);
  await until(() => a.state.lobbyChat.status === 'error'); assert.equal(provider.calls[0].signal.aborted, true);
  for (let i = 1; i <= 11; i++) {
    a.send({ type: 'lobby_chat', text: '问题 ' + i }); await until(() => provider.calls.length === i + 1);
    assert.ok(provider.calls[i].history.length <= 20);
    provider.calls[i].resolve({ text: '回答 ' + i });
    await until(() => a.state.lobbyChat.status === 'idle' && a.state.lobbyChat.messages.at(-1).text === '回答 ' + i);
  }
  provider.calls[0].resolve({ text: 'LATE_TIMEOUT_REPLY' }); await pause(20);
  assert.equal(a.state.lobbyChat.messages.length, 20);
  assert.ok(!JSON.stringify(a.inbox).includes('LATE_TIMEOUT_REPLY'));
});

test('closing service aborts companion work and no agent message appears from late completion', async t => {
  const provider = delayedChat(); const { service, url } = await setup(t, { provider });
  const a = await client(url, { type: 'create', name: '甲' }); await a.wait(m => m.type === 'state');
  a.send({ type: 'lobby_chat', text: '即将停服务' }); await until(() => provider.calls.length === 1);
  await service.close();
  assert.equal(provider.calls[0].signal.aborted, true);
  provider.calls[0].resolve({ text: 'LATE_CLOSE_REPLY' }); await pause(10);
  assert.ok(!JSON.stringify(a.inbox).includes('LATE_CLOSE_REPLY'));
});

test('errors identify the validated request type without echoing arbitrary client input', async t => {
  const { url } = await setup(t, { provider: null });
  const a = await client(url, { type: 'create', name: '甲' }); await a.wait(m => m.type === 'state');
  a.send({ type: 'lobby_chat', text: '' });
  const chatError = await a.wait(m => m.type === 'error' && m.requestType === 'lobby_chat');
  assert.ok(chatError.message);
  a.send({ type: 'start' });
  const startError = await a.wait(m => m.type === 'error' && m.requestType === 'start');
  assert.match(startError.message, /尚未配置/);
  a.send({ type: 'UNRECOGNIZED_INPUT_NOT_ECHOED' });
  const unknown = await a.wait(m => m.type === 'error' && m.message === '不支持的操作');
  assert.equal(unknown.requestType, undefined);
  assert.ok(!JSON.stringify(unknown).includes('UNRECOGNIZED_INPUT'));
});
