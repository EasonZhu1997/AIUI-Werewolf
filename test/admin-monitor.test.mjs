import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceMonitor } from '../server/monitor.mjs';
import { Game } from '../server/game.mjs';

function fixture() {
  const game = new Game({ roomId: '0048', now: () => 2000, random: () => 0.999 });
  game.join({ id: 'PRIVATE_PLAYER_ID', name: '小伙伴' });
  const room = { game, sockets: new Map([['PRIVATE_PLAYER_ID', {}]]), acks: new Set(), createdAt: 1000, lastActive: 2000,
    lobbyChat: { status: 'idle', messages: [{ text: 'PRIVATE_CHAT_TEXT' }], error: 'PRIVATE_ERROR_TEXT' } };
  const rooms = new Map([['0048', room]]);
  const provider = { apiKey: 'PRIVATE_API_KEY', getMetrics: () => ({ configured: true, model: 'test-model', callsLastHour: 5, maxCallsPerHour: 600,
    successes: 3, failures: 1, cancellations: 0, inFlight: 1, averageLatencyMs: 50, lastSuccessAt: 1500, lastFailureAt: 1700, hidden: 'PRIVATE_PROVIDER_EXTRA' }) };
  const monitor = new ServiceMonitor({ now: () => 2000 });
  return { game, room, rooms, monitor, snapshot: () => monitor.snapshot({ rooms, connections: [{ wantsRooms: true }, { room }], provider, maxRooms: 12, maxConnections: 72 }) };
}

test('admin monitoring is a fixed operational projection and never reads hidden roles, chats or credentials', () => {
  const f = fixture(); f.game.start('PRIVATE_PLAYER_ID');
  f.game.players[0].clues.push('PRIVATE_CLUE'); f.game.logs.push({ text: 'PRIVATE_GAME_LOG' });
  f.room.lobbyChat.messages.push({ text: 'PRIVATE_CHAT_TEXT' });
  const before = JSON.stringify(f.game);
  const result = f.snapshot();
  assert.equal(JSON.stringify(f.game), before);
  assert.equal(result.rooms[0].deadline, null, 'private night substage timing hidden');
  assert.equal(result.summary.onlineHumans, 1); assert.equal(result.summary.botSeats, 5);
  assert.equal(result.summary.activeRooms, 1); assert.equal(result.summary.directoryConnections, 1);
  assert.equal(result.ai.failures, 1); assert.equal(result.limits.maxPlayers, 6);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  for (const p of result.rooms[0].players) assert.deepEqual(Object.keys(p).sort(), ['seat', 'name', 'bot', 'connected', 'alive'].sort());
});

test('admin snapshot distinguishes waiting, pause, AI error and actual outstanding playback acknowledgements', () => {
  const f = fixture();
  assert.equal(f.snapshot().summary.waitingRooms, 1);
  f.game.phase = 'playback'; f.game.speech = { id: 'PRIVATE_SPEECH_ID', text: 'PRIVATE_SPEECH_TEXT' };
  f.room.failedKey = 'PRIVATE_KEY'; f.room.aiStatus = 'PRIVATE_RAW_ERROR';
  let result = f.snapshot();
  assert.equal(result.rooms[0].aiState, 'error');
  assert.deepEqual(result.rooms[0].playback, { pendingAcks: 1, totalHumans: 1 });
  f.room.acks.add('PRIVATE_PLAYER_ID'); assert.equal(f.snapshot().rooms[0].playback.pendingAcks, 0);
  f.room.sockets.clear(); result = f.snapshot();
  assert.equal(result.summary.onlineHumans, 0); assert.equal(result.summary.pausedRooms, 1);
  assert.equal(result.rooms[0].deadline, null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('operational event history is bounded, deduplicates polling and forgets removed room baselines', () => {
  const f = fixture(); f.monitor.eventLimit = 8;
  f.monitor.observe(f.room); const count = f.monitor.events.length;
  for (let i = 0; i < 30; i++) f.monitor.observe(f.room);
  assert.equal(f.monitor.events.length, count);
  f.room.lobbyChat.status = 'error'; f.monitor.observe(f.room);
  assert.equal(f.monitor.events[0].kind, 'companion_failed');
  for (let i = 0; i < 30; i++) { f.game.round++; f.monitor.observe(f.room); }
  assert.equal(f.monitor.events.length, 8);
  f.monitor.removed('0048', 'empty'); assert.equal(f.monitor.roomStates.size, 0);
  assert.equal(f.monitor.events[0].kind, 'room_removed');
  const removedId = f.monitor.events[0].id;
  f.monitor.observe(f.room);
  assert.ok(f.monitor.events.some(event => event.kind === 'room_created' && event.id > removedId));
  assert.ok(!JSON.stringify(f.monitor.events).includes('PRIVATE_'));
});

test('missing provider metrics remain unavailable instead of inventing zero successes', () => {
  const monitor = new ServiceMonitor();
  const value = monitor.snapshot({ rooms: new Map(), provider: null, maxRooms: 12, maxConnections: 72 });
  assert.equal(value.ai.configured, false); assert.equal(value.ai.successes, null); assert.equal(value.summary.rooms, 0);
});
