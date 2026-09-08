import test from 'node:test';
import assert from 'node:assert/strict';
import { LobbyChatController, roomDirectoryEntries } from '../web/lobby.js';

const view = (messages = [], overrides = {}) => ({ roomId: '0037', selfId: 'me', phase: 'lobby', players: [{ id: 'me', name: '旅人' }], lobbyChat: { messages, status: 'idle', error: '' }, ...overrides });
const agent = (id, text = '你好，想先聊聊怎么玩吗？') => ({ id, kind: 'agent', name: '小月', text });
const human = (id, text = '请讲讲女巫怎么玩') => ({ id, kind: 'human', name: '旅人', text });
function harness() {
  const utterances = [], drafts = [], statuses = [], requests = [], instances = [], timers = new Map();
  let timerId = 0;
  class Utterance { constructor(text) { this.text = text; } }
  class Recognition {
    constructor() { this.aborted = 0; this.started = 0; instances.push(this); }
    start() { this.started++; }
    stop() {}
    abort() { this.aborted++; }
  }
  const synth = { speak: u => utterances.push(u), cancel() { this.canceled = (this.canceled || 0) + 1; }, getVoices: () => [{ lang: 'zh-CN', name: 'Test Mandarin' }] };
  const chat = new LobbyChatController({ synth, Utterance, Recognition,
    setTimer: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id),
    onDraft: draft => drafts.push(draft), onVoiceStatus: status => statuses.push(status),
  });
  return { chat, synth, utterances, drafts, statuses, requests, instances, timers, send: text => requests.push(text) };
}

test('directory contains only room occupancy/status, with full and started tables disabled', () => {
  const rooms = roomDirectoryEntries([
    { roomId: '0037', phase: 'lobby', members: 2, online: 1, canJoin: true, players: ['private name'] },
    { roomId: '0038', phase: 'lobby', members: 6, online: 6, canJoin: true },
    { roomId: '0039', phase: 'night', members: 6, online: 1, canJoin: true },
    { roomId: 'lobby', phase: 'lobby', members: 0, online: 0, canJoin: true },
    { roomId: 'bad<script>', phase: 'lobby', members: 0, canJoin: true },
    { roomId: '0037', phase: 'lobby', members: 1, canJoin: true },
  ]);
  assert.equal(rooms.length, 4);
  assert.equal(rooms[0].canJoin, true);
  assert.equal(rooms[1].canJoin, false);
  assert.equal(rooms[2].canJoin, false);
  assert.equal(rooms[2].members, 6);
  assert.equal(rooms[2].online, 1);
  assert.equal(rooms[3].label, '公共大厅');
  assert.ok(!JSON.stringify(rooms).includes('private name'));
});

test('entering a room establishes history without replaying old agent messages or opening the mic', () => {
  const h = harness(); h.chat.sync(view([human('h1'), agent('a1')]));
  assert.equal(h.utterances.length, 0);
  assert.equal(h.instances.length, 0);
  assert.equal(h.chat.messages.length, 2);
  assert.equal(h.chat.active, true);
});

test('new agent replies play once in order and never send a game acknowledgment', () => {
  const h = harness(); h.chat.sync(view());
  h.chat.sync(view([agent('a1'), agent('a2', '我们等大家入座，随时都可以开局。')]));
  assert.equal(h.utterances.length, 1);
  h.chat.sync(view([agent('a1'), agent('a2')]));
  assert.equal(h.utterances.length, 1);
  h.utterances[0].onend();
  assert.equal(h.utterances.length, 2);
  h.utterances[1].onend();
  h.utterances[1].onerror();
  assert.deepEqual(h.requests, []);
  assert.equal(h.chat.queue.length, 0);
  assert.equal(h.timers.size, 0);
});

test('confirmed text alone is sent and server-visible receipt clears only that draft', () => {
  const h = harness(); h.chat.sync(view());
  h.chat.setDraft('请讲讲女巫怎么玩');
  assert.deepEqual(h.requests, []);
  assert.equal(h.chat.submit(h.send), true);
  assert.deepEqual(h.requests, ['请讲讲女巫怎么玩']);
  assert.equal(h.chat.busy, true);
  h.chat.sync(view([human('h1')], { lobbyChat: { messages: [human('h1')], status: 'thinking' } }));
  assert.equal(h.chat.draft, '');
  assert.equal(h.chat.busy, true);
  h.chat.setDraft('那预言家呢');
  assert.equal(h.chat.submit(h.send), false);
  assert.equal(h.chat.draft, '那预言家呢');
});

test('voice recognition creates a draft that is not sent until explicitly confirmed', () => {
  const h = harness(); h.chat.sync(view()); h.chat.startVoice();
  const recognition = h.instances[0];
  recognition.onresult({ results: [[{ transcript: '我第一次玩，怎么开始？' }]] });
  assert.equal(h.chat.draft, '我第一次玩，怎么开始？');
  assert.deepEqual(h.requests, []);
  assert.equal(h.chat.submit(h.send), true);
  assert.deepEqual(h.requests, ['我第一次玩，怎么开始？']);
});

test('starting the game stops chat audio and mic, discards its draft and rejects late recognition', () => {
  const h = harness(); h.chat.sync(view()); h.chat.startVoice();
  const recognition = h.instances[0];
  h.chat.setDraft('还没发送');
  h.chat.sync(view([agent('a1')])); // Reply waits while the mic is active.
  assert.equal(h.utterances.length, 0);
  h.chat.sync(view([], { phase: 'night' }));
  recognition.onresult({ results: [[{ transcript: '迟到的等待区文字' }]] });
  assert.equal(h.chat.draft, '');
  assert.equal(h.chat.active, false);
  assert.equal(h.chat.queue.length, 0);
  assert.equal(h.chat.submit(h.send), false);
  assert.equal(h.chat.voice.active, false);
  assert.equal(h.utterances.length, 0);
});

test('starting while a reply plays cancels it and clears the now-stale playback status', () => {
  const h = harness(); h.chat.sync(view()); h.chat.sync(view([agent('a1')]));
  h.utterances[0].onstart();
  h.chat.sync(view([], { phase: 'night' }));
  h.utterances[0].onend();
  assert.equal(h.chat.playing, false);
  assert.equal(h.chat.active, false);
  assert.equal(h.statuses.at(-1), '等待区语音已停止');
  assert.equal(h.timers.size, 0);
});

test('clicking start immediately suppresses queued lobby snapshots until game starts or fails', () => {
  const h = harness(); h.chat.sync(view());
  h.chat.prepareGame();
  h.chat.sync(view([agent('in-flight-before-start')]));
  assert.equal(h.chat.active, false);
  assert.equal(h.chat.startRequested, true);
  assert.equal(h.utterances.length, 0);
  h.chat.cancelGameStart();
  h.chat.sync(view([agent('in-flight-before-start')]));
  assert.equal(h.chat.active, true);
  assert.equal(h.utterances.length, 0);
  h.chat.sync(view([agent('in-flight-before-start'), agent('new-after-failure')]));
  assert.equal(h.utterances.length, 1);
});

test('late chat or untyped errors cannot release a pending start and replay lobby replies', () => {
  const h = harness(); h.chat.sync(view()); h.chat.prepareGame();
  for (const error of [{ requestType: 'lobby_chat', message: '请稍候再发一条消息' }, { message: '旧服务未标记来源的错误' }]) {
    assert.equal(h.chat.handleServerError(error).needsSync, true);
    h.chat.sync(view([agent(`late-${error.message}`)]));
    assert.equal(h.chat.startRequested, true);
    assert.equal(h.chat.active, false);
    assert.equal(h.utterances.length, 0);
  }
  h.chat.sync(view([], { phase: 'night' }));
  assert.equal(h.chat.startRequested, false);
  assert.equal(h.chat.active, false);
});

test('only an explicit start rejection or a fresh session allows waiting-room recovery', () => {
  const h = harness(); h.chat.sync(view()); h.chat.prepareGame();
  assert.equal(h.chat.handleServerError({ requestType: 'start', message: '无法开局' }).needsSync, false);
  assert.equal(h.chat.startRequested, false);
  h.chat.sync(view([agent('history-during-rejected-start')]));
  assert.equal(h.chat.active, true);
  assert.equal(h.utterances.length, 0);
  h.chat.prepareGame();
  h.chat.handleServerError({ requestType: 'lobby_chat' });
  h.chat.reset(); // User-initiated reconnect establishes a new authoritative baseline.
  h.chat.sync(view([agent('history-after-reconnect')]));
  assert.equal(h.chat.startRequested, false);
  assert.equal(h.chat.active, true);
  assert.equal(h.utterances.length, 0);
});

test('hidden replies remain text-only and returning does not replay background history', () => {
  const h = harness(); h.chat.sync(view()); h.chat.sync(view([agent('a1')]));
  h.chat.setHidden(true);
  h.chat.sync(view([agent('a1'), agent('a2')]), { hidden: true });
  h.chat.setHidden(false);
  h.chat.sync(view([agent('a1'), agent('a2')]));
  assert.equal(h.utterances.length, 1);
  h.chat.sync(view([agent('a1'), agent('a2'), agent('a3')]));
  assert.equal(h.utterances.length, 2);
});

test('a new room or seat invalidates old voice callbacks, queued replies and unsent text', () => {
  const h = harness(); h.chat.sync(view()); h.chat.startVoice();
  const recognition = h.instances[0]; h.chat.setDraft('旧房间文本');
  h.chat.sync(view([agent('other-history')], { roomId: '7777', selfId: 'new-seat' }));
  recognition.onresult({ results: [[{ transcript: '旧房间迟到识别' }]] });
  assert.equal(h.chat.draft, '');
  assert.equal(h.utterances.length, 0);
  assert.equal(h.chat.lastSent, '');
});

test('model errors can retry the last confirmed text without blocking a later return', () => {
  const h = harness(); h.chat.sync(view()); h.chat.setDraft('请讲讲女巫怎么玩'); h.chat.submit(h.send);
  h.chat.sync(view([human('h1')], { lobbyChat: { messages: [human('h1')], status: 'error', error: 'AI 暂时无法回应' } }));
  assert.equal(h.chat.busy, false);
  assert.match(h.chat.error, /无法回应/);
  assert.equal(h.chat.retry(h.send), true);
  assert.equal(h.requests.length, 2);
  h.chat.reset();
  assert.equal(h.chat.active, false);
  assert.equal(h.chat.lastSent, '');
});

test('muting preserves new reply text but starts no audible utterance', () => {
  const h = harness(); h.chat.sync(view()); h.chat.setEnabled(false); h.chat.sync(view([agent('a1')]));
  assert.equal(h.utterances.length, 0);
  assert.equal(h.chat.messages[0].text, agent('a1').text);
  assert.equal(h.chat.playing, false);
});
