import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Game } from '../server/game.mjs';
import { runPublicSmoke, redactSpeech } from '../tools/smoke-public.mjs';

function fakeTransport({ stall = false, occupied = false, leak = false } = {}) {
  const game = new Game({ roomId: '8137', random: () => 0.999 });
  if (occupied) game.join({ id: 'EXISTING_PERSON', name: '别人的房间' });
  const clients = [];
  const messages = [];
  const acks = new Map();
  let botBusy = false;
  let calls = 0;
  const broadcast = () => {
    for (const client of clients) {
      if (!client.playerId || client.readyState !== 1 || !game.players.some(player => player.id === client.playerId)) continue;
      const state = game.view(client.playerId);
      if (leak && state.phase === 'night') state.players.find(player => player.id !== client.playerId).role = 'wolf';
      client.emit('message', JSON.stringify({ type: 'state', state }), false);
    }
  };
  const pump = () => {
    if (stall || botBusy || !clients.some(client => client.readyState === 1)) return;
    const pending = game.pendingAI();
    if (!pending) return;
    botBusy = true;
    setTimeout(() => {
      botBusy = false;
      if (!clients.some(client => client.readyState === 1)) return;
      const current = game.pendingAI();
      if (!current) return;
      calls++;
      let action;
      if (current.kind === 'speech') action = { kind: 'speech', text: `${current.context.selfSeat}号发言：我想听6号解释怀疑别人的依据，然后再投票。` };
      else {
        const choice = current.choices.find(item => item.action === (current.kind === 'night' ? 'kill' : 'vote') && item.target === (current.kind === 'night' ? 5 : 6));
        action = choice ? { kind: current.kind, action: choice.action, target: choice.target } : { kind: current.kind, action: 'skip', target: null };
      }
      game.act(current.playerId, action);
      broadcast(); pump();
    }, 2);
  };
  class Socket extends EventEmitter {
    constructor(url, options) {
      super(); this.readyState = 0; this.options = options;
      assert.match(url, /^wss:/);
      clients.push(this);
      setImmediate(() => { if (this.readyState === 0) { this.readyState = 1; this.emit('open'); } });
    }
    send(raw) {
      const msg = JSON.parse(raw);
      messages.push(msg.type);
      queueMicrotask(() => {
        try {
          if (msg.type === 'join') {
            this.playerId = `PRIVATE_PLAYER_ID_${clients.indexOf(this) + 1}`;
            game.join({ id: this.playerId, name: msg.name });
            this.emit('message', JSON.stringify({ type: 'welcome', playerId: this.playerId, resumeToken: 'RESUME_TOKEN_NEVER_LOG_ME' }), false);
          } else if (msg.type === 'start') game.start(this.playerId);
          else if (msg.type === 'action') {
            if (msg.revision !== game.revision) throw new Error('房间进度已更新');
            game.act(this.playerId, msg.action);
          } else if (msg.type === 'speech_done' && game.speech?.id === msg.speechId) {
            if (!acks.has(msg.speechId)) acks.set(msg.speechId, new Set());
            acks.get(msg.speechId).add(this.playerId);
            if (clients.filter(client => client.playerId && client.readyState === 1).every(client => acks.get(msg.speechId).has(client.playerId))) game.completePlayback(msg.speechId);
          } else if (msg.type === 'leave') game.leave(this.playerId);
          broadcast(); pump();
        } catch (error) {
          this.emit('message', JSON.stringify({ type: 'error', message: error.message }), false);
        }
      });
    }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  return { Socket, clients, messages, get calls() { return calls; } };
}

for (const humans of [1, 2]) test(`external smoke contract completes with ${humans} human client(s) using only an injected fake transport`, async () => {
  const transport = fakeTransport();
  const report = await runPublicSmoke({ url: 'wss://example.test/werewolf/ws', roomId: '8137', humans, timeoutMs: 5000, WebSocketImpl: transport.Socket });
  assert.equal(report.ok, true, report.errorCode);
  assert.equal(report.result.winner, 'wolves');
  assert.ok(report.aiSpeechCount > 0);
  assert.equal(report.allPublicSpeechSeenByAllClients, true);
  assert.equal(report.cleanup.allClientsClosed, true);
  assert.equal(transport.messages.filter(message => message === 'leave').length, humans);
  assert.ok(transport.clients.every(client => client.options.rejectUnauthorized === true));
  const serialized = JSON.stringify(report);
  for (const forbidden of ['RESUME_TOKEN_NEVER_LOG_ME', 'PRIVATE_PLAYER_ID_', 'example.test', '8137']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.ok(report.limitations.some(line => line.includes('Provider identity')));
});

test('deadline failure closes every socket and sends leave without creating further games', async () => {
  const transport = fakeTransport({ stall: true });
  const report = await runPublicSmoke({ url: 'wss://example.test/werewolf/ws', roomId: '8137', timeoutMs: 100, WebSocketImpl: transport.Socket });
  assert.equal(report.ok, false);
  assert.equal(report.errorCode, 'GAME_TIMEOUT');
  assert.equal(report.cleanup.allClientsClosed, true);
  assert.equal(transport.messages.filter(message => message === 'start').length, 1);
  assert.equal(transport.messages.filter(message => message === 'leave').length, 1);
});

test('preexisting room is left without starting or resetting somebody else game', async () => {
  const transport = fakeTransport({ occupied: true });
  const report = await runPublicSmoke({ url: 'wss://example.test/werewolf/ws', roomId: '8137', timeoutMs: 1000, WebSocketImpl: transport.Socket });
  assert.equal(report.errorCode, 'ROOM_ALREADY_IN_USE');
  assert.equal(transport.calls, 0);
  assert.ok(!transport.messages.includes('start'));
  assert.ok(!transport.messages.includes('restart'));
  assert.equal(report.cleanup.allClientsClosed, true);
});

test('private role exposure fails the probe without recording raw views', async () => {
  const transport = fakeTransport({ leak: true, stall: true });
  const report = await runPublicSmoke({ url: 'wss://example.test/werewolf/ws', roomId: '8137', timeoutMs: 1000, WebSocketImpl: transport.Socket });
  assert.equal(report.errorCode, 'PRIVATE_ROLE_LEAK');
  assert.equal(report.cleanup.allClientsClosed, true);
  assert.ok(!JSON.stringify(report).includes('selfId'));
});

test('unsafe endpoint, unbounded duration, or unsupported human count are rejected before connecting', async () => {
  for (const invalid of [
    { url: 'ws://example.test/werewolf/ws' },
    { url: 'wss://name:secret@example.test/werewolf/ws' },
    { url: 'wss://example.test/werewolf/ws?token=secret' },
    { timeoutMs: 3600000 }, { humans: 3 }, { roomId: 'lobby' },
  ]) {
    let connected = false;
    class ForbiddenTransport { constructor() { connected = true; } }
    await assert.rejects(runPublicSmoke({ url: 'wss://example.test/werewolf/ws', ...invalid, WebSocketImpl: ForbiddenTransport }));
    assert.equal(connected, false);
  }
});

test('speech sample sanitization removes links, secret-shaped values, identifiers and email addresses', () => {
  const text = '2号说 https://private.example/secret sk-abcdefghijklmnopqrst abcdef0123456789abcdef0123456789 demo@example.test';
  const cleaned = redactSpeech(text);
  assert.ok(cleaned.startsWith('2号说'));
  for (const secret of ['private.example', 'abcdefghijklmnopqrst', 'abcdef0123456789', 'demo@example.test']) assert.ok(!cleaned.includes(secret));
});
