import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RoomDigitInput } from '../lib/room-input.js';
import { GlassesSpeech } from '../lib/glasses-speech.js';
import { glassesStage, glassesCountdown } from '../lib/glasses-stage.js';

const ink = await readFile(new URL('../pages/game/index.ink', import.meta.url), 'utf8');
const script = ink.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '').replace('export default', 'return');
function page() {
  const calls = [];
  const saved = new Map();
  const wx = { getStorageSync(key) { return saved.get(key); }, setStorageSync(key, value) { saved.set(key, value); }, removeStorageSync(key) { saved.delete(key); } };
  const definition = new Function('config', 'RoomDigitInput', 'wx', 'GlassesSpeech', 'PoseDigitControl', 'GameClient', 'glassesStage', 'glassesCountdown', script)(
    { url: 'wss://example.test/werewolf/ws', version: '0.1.0' }, RoomDigitInput, wx, GlassesSpeech,
    class { stop() {} }, class { constructor(options) { this.options = options; } disconnect() {} }, glassesStage, glassesCountdown
  );
  let timerId = 0;
  const timeouts = new Map(), intervals = new Map();
  const uiTimers = { setTimeout(fn) { const id = ++timerId; timeouts.set(id, fn); return id; }, clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); } };
  const p = { ...definition, data: { ...definition.data }, alive: true, foreground: true,
    roomId: '0037', panel: 'main', pageIndex: 0, choiceIndex: 0, commandIndex: 0, commands: [], transcript: '', promptKey: '',
    audio: { completed: new Set(), abortListening() { calls.push('abort'); }, speak(speech) { calls.push(['speak', speech.id]); }, narrate(cue) { calls.push(['narrate', cue]); }, stopPlayback() {}, startListening() { calls.push('mic'); }, stopListening() {}, setMuted() {}, suspend() { calls.push('suspend'); } },
    lobbyAudio: { play: null, narrate(value) { calls.push(['lobby-narrate', value]); }, suspend() { calls.push('lobby-suspend'); }, startListening() { calls.push('lobby-mic'); }, stopListening() { calls.push('lobby-stop'); }, setMuted() {} },
    client: { sendAction(action) { calls.push(['action', action]); }, join(options) { calls.push(['join', options]); }, create(options) { calls.push(['create', options]); }, browse() { calls.push('browse'); }, refreshRooms() { calls.push('refresh'); }, chat(text) { calls.push(['chat', text]); }, speechDone(id) { calls.push(['speech_done', id]); }, leave() { calls.push('leave'); }, start() { calls.push('start'); }, restart() { calls.push('restart'); }, disconnect() { calls.push('disconnect'); } },
    setData(update) { Object.assign(this.data, update); }, calls, saved, resumeInMemory: {}, roomEpoch: 1, uiTimers, timeouts, intervals, lobbyQueue: [], lobbySeen: new Set(), lobbyEpoch: 0, lobbySeeded: false, rooms: [], roomSelection: 0 };
  return p;
}
function view(extra = {}) {
  return { roomId: '0037', revision: 1, round: 1, phase: 'night', phaseLabel: '夜间行动', deadline: null,
    selfId: 'me', selfSeat: 1, players: [{ id: 'me', seat: 1, name: '眼镜玩家', alive: true, bot: false, connected: true }],
    self: { role: 'seer', roleName: '预言家', clues: ['昨夜查验 2 号是好人'] }, logs: [],
    prompt: null, speech: null, canStart: false, canRestart: false, ...extra };
}
function choose(p, id) { const index = p.commands.findIndex((c) => c.id === id); assert.ok(index >= 0, `missing command ${id}`); p.commandIndex = index; p.activateAction(); }

test('all essential game phases provide actionable glasses commands', () => {
  const p = page(); p.receiveState(view({ phase: 'lobby', canStart: true })); choose(p, 'start'); assert.ok(p.calls.includes('start'));
  p.receiveState(view({ prompt: { kind: 'night', label: '查验', choices: [{ target: 2, action: 'inspect', label: '查验 2 号' }, { target: 3, action: 'inspect', label: '查验 3 号' }] } }));
  p.nextContent(); choose(p, 'choose');
  assert.deepEqual(p.calls.find((c) => c[0] === 'action')[1], { kind: 'night', target: 3, action: 'inspect' });
  p.receiveState(view({ phase: 'vote', prompt: { kind: 'vote', label: '投票', choices: [{ target: null, action: 'skip', label: '弃票' }] } }));
  choose(p, 'choose'); assert.deepEqual(p.calls.filter((c) => c[0] === 'action').at(-1)[1], { kind: 'vote', target: null, action: 'skip' });
  p.receiveState(view({ phase: 'result', canRestart: true, result: { reason: '好人阵营获胜' } })); choose(p, 'restart'); assert.ok(p.calls.includes('restart'));
});

test('server speech triggers playback but human speech phase never auto-opens mic', () => {
  const p = page(); p.receiveState(view({ phase: 'playback', speech: { id: 'a', text: '请大家谨慎投票', seat: 2, name: 'AI' } }));
  assert.deepEqual(p.calls.find((c) => c[0] === 'speak'), ['speak', 'a']);
  p.receiveState(view({ phase: 'speech', prompt: { kind: 'speech', choices: [], label: '发言' } }));
  assert.equal(p.calls.includes('mic'), false); assert.equal(p.calls.some((c) => c[0] === 'action'), false);
  choose(p, 'mic'); assert.ok(p.calls.includes('mic'));
  p.transcript = '我想先听一下二号的解释。'; p.renderGame(); choose(p, 'send');
  assert.deepEqual(p.calls.filter((c) => c[0] === 'action').at(-1)[1], { kind: 'speech', text: p.transcript });
});

test('new phase discards unsent transcript and cancels microphone', () => {
  const p = page(); p.receiveState(view({ phase: 'speech', prompt: { kind: 'speech', choices: [], label: '发言' } }));
  p.transcript = '未确认的私下发言';
  p.receiveState(view({ phase: 'vote' }));
  assert.equal(p.transcript, ''); assert.ok(p.calls.includes('abort'));
  assert.equal(p.commands.some((c) => c.id === 'send'), false);
});

test('private clues and long public speech can be paged with key and button controls', () => {
  const p = page(); p.receiveState(view({ phase: 'playback', speech: { id: 'long', seat: 2, name: 'AI', text: '甲'.repeat(150) } }));
  assert.equal(p.data.pageLabel, '1/3'); p.nextContent(); assert.equal(p.data.pageLabel, '2/3');
  choose(p, 'clues'); assert.ok(p.data.contentText.includes('昨夜查验 2 号是好人')); choose(p, 'main');
  assert.equal(p.panel, 'main');
});

test('only handled key events prevent host default behavior', () => {
  const p = page(); let prevented = 0;
  p.onKeyUp({ code: 'KeyQ', preventDefault() { prevented++; } }); assert.equal(prevented, 0);
  p.data.screen = 'edit'; p.editor = new RoomDigitInput(); p.pose = { suppress() {} };
  p.onKeyUp({ code: 'ArrowRight', preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.equal(p.editor.room[0], '1');
});

test('hide stops sensor, voice and socket without sending a game leave', () => {
  const p = page(); p.pose = { stop() { p.calls.push('stop-pose'); } };
  p.onHide(); assert.equal(p.foreground, false);
  assert.ok(p.calls.includes('stop-pose')); assert.ok(p.calls.includes('suspend')); assert.ok(p.calls.includes('disconnect'));
});

test('page boots when preview has no speech module or speech globals', () => {
  assert.doesNotMatch(ink, /from ['"]speech['"]/);
  const p = page();
  try {
    assert.doesNotThrow(() => p.onLoad());
    assert.equal(p.data.screen, 'home');
    assert.equal(p.audio.synthesis, null);
    assert.equal(p.audio.startListening(), false);
    assert.match(p.data.notice, /无法开启语音识别/);
  } finally { p.onUnload(); }
});

test('return from hidden page resumes saved room and does not open microphone', () => {
  const p = page(); p.data.screen = 'game';
  p.saved.set(p.storageKey(), { resumeToken: 'saved-seat' });
  p.pose = { stop() {} }; p.onHide(); p.onShow();
  assert.deepEqual(p.calls.filter((c) => c[0] === 'join'), [['join', { roomId: '0037', name: '眼镜玩家', resumeToken: 'saved-seat', createIfMissing: false }]]);
  assert.equal(p.calls.includes('mic'), false); assert.equal(p.foreground, true);
});

test('expired resume record is cleared and fresh join attempted once', () => {
  const p = page(); p.saved.set(p.storageKey(), { resumeToken: 'expired-seat' });
  p.client.lastError = { code: 'RESUME_EXPIRED', message: '旧座位失效' };
  p.handleClientStatus('旧座位失效');
  assert.equal(p.saved.size, 0);
  assert.deepEqual(p.calls.filter((c) => c[0] === 'join'), [['join', { roomId: '0037', name: '眼镜玩家', resumeToken: undefined, createIfMissing: false }]]);
  p.handleClientStatus('正在连接');
  assert.equal(p.calls.filter((c) => c[0] === 'join').length, 1);
  assert.deepEqual(p.commands.map((c) => c.id), ['reconnect', 'leave']);
});

test('active leave preserves resume token, lobby leave clears it', () => {
  const p = page(); const key = p.storageKey();
  p.pose = { stop() {} }; p.saved.set(key, { resumeToken: 'active-seat' }); p.view = view({ phase: 'vote' });
  p.leaveRoom(); assert.deepEqual(p.saved.get(key), { resumeToken: 'active-seat' });
  p.enterRoom('0037');
  assert.equal(p.calls.filter((c) => c[0] === 'join').at(-1)[1].resumeToken, 'active-seat');
  p.view = view({ phase: 'lobby' }); p.leaveRoom(); assert.equal(p.saved.has(key), false);
});

test('four digit confirmation preserves leading zeroes and stops pose before joining', () => {
  const p = page(); p.pose = { stop() { p.calls.push('stop-pose'); }, suppress() {} };
  p.editor = new RoomDigitInput(); p.data.screen = 'edit';
  p.confirmDigit(); p.confirmDigit(); p.incrementDigit(); p.confirmDigit();
  p.incrementDigit(); p.incrementDigit(); p.confirmDigit();
  assert.equal(p.data.screen, 'game');
  assert.equal(p.calls.filter((c) => c[0] === 'join').at(-1)[1].roomId, '0012');
  assert.ok(p.calls.indexOf('stop-pose') < p.calls.findIndex((c) => c[0] === 'join'));
});

test('host phase cues narrate public instructions and game result without private clues', () => {
  const p = page(); p.receiveState(view());
  const night = p.calls.filter((c) => c[0] === 'narrate').at(-1)[1];
  assert.match(night.text, /天黑请闭眼/); assert.doesNotMatch(night.text, /查验 2 号|预言家/);
  p.receiveState(view({ phase: 'result', result: { reason: '所有狼人已出局，好人获胜。' } }));
  assert.match(p.calls.filter((c) => c[0] === 'narrate').at(-1)[1].text, /好人获胜/);
});

test('restart gives host narration a new identity even when day number repeats', () => {
  const p = page(); p.receiveState(view({ phase: 'lobby' })); p.receiveState(view());
  const firstId = p.calls.filter((c) => c[0] === 'narrate').at(-1)[1].id;
  p.receiveState(view({ phase: 'result', result: { reason: '结束' } }));
  p.receiveState(view({ phase: 'lobby' })); p.receiveState(view());
  assert.notEqual(p.calls.filter((c) => c[0] === 'narrate').at(-1)[1].id, firstId);
});

test('stage transition is emphasized once and ordinary revisions do not restart motion', () => {
  const p = page(); p.receiveState(view());
  assert.equal(p.data.stageName, '夜晚行动'); assert.equal(p.data.stageFlash, true);
  assert.equal(p.data.stageSteps.filter(s => s.active)[0].name, '夜晚');
  const motion = p.motionGeneration;
  p.receiveState(view({ revision: 2, aiStatus: 'AI 正在处理夜晚行动' }));
  assert.equal(p.motionGeneration, motion);
  p.receiveState(view({ revision: 3, phase: 'vote', prompt: { kind: 'vote', label: '投票', choices: [{ target: null, action: 'skip', label: '弃票' }] } }));
  assert.equal(p.data.stageBadge, '轮到你'); assert.equal(p.data.stageName, '放逐投票');
  assert.ok(p.motionGeneration > motion);
});

test('shared speech and playback keep one large phase while own turn is highlighted', () => {
  const p = page(); p.receiveState(view({ phase: 'speech' })); const motion = p.motionGeneration;
  p.receiveState(view({ phase: 'playback', speech: { id: 'a', seat: 2, name: 'AI', text: '听我说。' } }));
  assert.equal(p.motionGeneration, motion);
  p.receiveState(view({ phase: 'speech', prompt: { kind: 'speech', choices: [], label: '发言' } }));
  assert.equal(p.data.ownTurn, true); assert.equal(p.data.stageBadge, '轮到你');
  assert.ok(p.motionGeneration > motion);
});

test('hide stops countdown and phase motion; stale animation callback cannot alter the page', () => {
  const p = page(); p.pose = { stop() {} }; p.receiveState(view());
  const late = [...p.timeouts.values()];
  assert.equal(p.intervals.size, 1); assert.equal(p.timeouts.size, 2);
  p.onHide(); const snapshot = JSON.stringify(p.data);
  assert.equal(p.intervals.size, 0); assert.equal(p.timeouts.size, 0);
  late.forEach(fn => fn()); assert.equal(JSON.stringify(p.data), snapshot);
});

test('disconnect replaces stale actions and countdown with explicit local offline state', () => {
  const p = page(); p.receiveState(view({ deadline: Date.now() + 9000, prompt: { kind: 'night', choices: [{ target: 2, action: 'inspect', label: '查验' }] } }));
  assert.equal(p.data.clockUrgent, true);
  p.handleClientStatus('连接已断开，请重新加入');
  assert.equal(p.data.stageMode, 'offline'); assert.equal(p.data.timeLabel, '未同步');
  assert.equal(p.data.hasChoices, false); assert.deepEqual(p.commands.map(c => c.id), ['reconnect', 'leave']);
  assert.match(p.data.roleLine, /等待重新同步/); assert.equal(p.intervals.size, 0);
});

test('home exposes four keyboard reachable entries with no automatic microphone', () => {
  const p = page(); const picked = [];
  p.createRoom = () => picked.push('create'); p.openDirectory = () => picked.push('rooms');
  p.openEditor = () => picked.push('number'); p.enterLobby = () => picked.push('public');
  for (let i = 0; i < 4; i++) { p.onKeyUp({ code: 'Enter' }); p.onKeyUp({ code: 'ArrowDown' }); }
  assert.deepEqual(picked, ['create', 'rooms', 'number', 'public']);
  assert.equal(p.calls.includes('mic'), false); assert.equal(p.calls.includes('lobby-mic'), false);
});

test('create stores resume token only after server assigns the four digit room', () => {
  const p = page(); p.onLoad();
  try {
    const creations = []; p.client.create = options => creations.push(options);
    p.createRoom(); p.createRoom();
    assert.equal(creations.length, 1); assert.equal(p.roomId, null); assert.equal(p.saved.size, 0);
    p.client.options.onWelcome({ roomId: '0123', playerId: 'created-self', resumeToken: 'created-seat' });
    assert.equal(p.roomId, '0123'); assert.equal(p.creating, false);
    assert.equal(p.saved.get(p.storageKey()).resumeToken, 'created-seat');
    assert.equal([...p.saved.keys()].some(key => key.endsWith(':null')), false);
  } finally { p.onUnload(); }
});

test('directory refuses occupied games, joins existing waiting rooms, and refreshes without stale sockets', () => {
  const p = page(); p.pose = { stop() {} }; p.openDirectory();
  assert.ok(p.calls.includes('browse'));
  p.receiveRooms([{ roomId: '1111', phase: 'night', members: 6, online: 2, canJoin: false }, { roomId: '0007', phase: 'lobby', members: 2, online: 2, canJoin: true }]);
  p.joinSelectedRoom(); assert.equal(p.calls.some(c => c[0] === 'join'), false);
  p.nextRoom(); p.joinSelectedRoom();
  assert.equal(p.calls.filter(c => c[0] === 'join').at(-1)[1].roomId, '0007');
  assert.equal(p.calls.filter(c => c[0] === 'join').at(-1)[1].createIfMissing, false);
  p.data.screen = 'rooms'; p.client.socket = null; p.client.mode = 'rooms';
  p.refreshDirectory(); assert.equal(p.calls.filter(c => c === 'refresh').length, 0);
  p.client.socket = {}; p.refreshDirectory(); assert.equal(p.calls.filter(c => c === 'refresh').length, 1);
});

test('first lobby history is silent; new companion replies queue without game acknowledgements', () => {
  const p = page(); const said = [];
  p.lobbyAudio.narrate = cue => { said.push(cue); p.lobbyAudio.play = {}; };
  const lobby = extra => view({ phase: 'lobby', canStart: true, lobbyChat: { messages: [], status: 'idle', ...extra } });
  const old = { id: 'old', kind: 'agent', name: '小月', text: '历史内容' };
  p.receiveState(lobby({ messages: [old] })); assert.equal(said.length, 0);
  const one = { id: 'one', kind: 'agent', name: '小月', text: '刚刚收到的回复' };
  const two = { id: 'two', kind: 'agent', name: '小月', text: '第二段回复' };
  p.receiveState(lobby({ messages: [old, one, two] })); assert.equal(said.length, 1);
  p.lobbyAudio.play = null; p.renderClock(); assert.equal(said.length, 2);
  p.receiveState(lobby({ messages: [old, one, two] })); assert.equal(said.length, 2);
  assert.equal(p.calls.filter(c => c[0] === 'speech_done').length, 0);
  assert.equal(p.calls.filter(c => c[0] === 'speak').length, 0);
});

test('lobby transcript is confirmed through chat only and retained until service confirmation', () => {
  const p = page(); p.receiveState(view({ phase: 'lobby', canStart: true, lobbyChat: { messages: [], status: 'idle' } }));
  choose(p, 'chat'); choose(p, 'chat-mic'); assert.ok(p.calls.includes('lobby-mic'));
  p.lobbyTranscript = '小月，你有什么新手建议？'; p.renderGame();
  assert.equal(p.calls.some(c => c[0] === 'chat'), false);
  choose(p, 'chat-send'); assert.deepEqual(p.calls.filter(c => c[0] === 'chat'), [['chat', '小月，你有什么新手建议？']]);
  assert.equal(p.calls.some(c => c[0] === 'action'), false); assert.equal(p.lobbyTranscript, '小月，你有什么新手建议？');
  p.receiveState(view({ phase: 'lobby', canStart: true, lobbyChat: { status: 'thinking', messages: [{ id: 'h', kind: 'human', name: '眼镜玩家', text: '小月，你有什么新手建议？' }] } }));
  assert.equal(p.lobbyTranscript, '');
});

test('any player can start while lobby reply is thinking; late lobby replies are not read after start', () => {
  const p = page(); p.receiveState(view({ phase: 'lobby', hostId: 'someone-else', canStart: true, lobbyChat: { status: 'thinking', messages: [] } }));
  choose(p, 'chat'); p.lobbyTranscript = '一段未发送草稿'; p.renderGame(); choose(p, 'start');
  assert.ok(p.calls.includes('start')); assert.equal(p.lobbyTranscript, ''); assert.ok(p.calls.includes('lobby-suspend'));
  p.receiveState(view({ phase: 'lobby', canStart: true, lobbyChat: { status: 'idle', messages: [{ id: 'late', kind: 'agent', name: '小月', text: '迟到的聊天回复' }] } }));
  assert.equal(p.calls.some(c => c[0] === 'lobby-narrate'), false);
  p.receiveState(view({ phase: 'night' })); assert.equal(p.lobbyQueue.length, 0);
});

test('late chat and untyped errors cannot reopen lobby narration after a start request', () => {
  for (const requestType of ['lobby_chat', undefined]) {
    const p = page(); const lobby = messages => view({ phase: 'lobby', canStart: true, lobbyChat: { status: 'idle', messages } });
    p.receiveState(lobby([])); choose(p, 'start');
    p.client.lastError = { message: '小月正在回复，请稍候', ...(requestType ? { requestType } : {}) };
    p.handleClientStatus(p.client.lastError.message);
    assert.equal(p.startRequested, true);
    // Error handling broadcasts current state; the provider can reply later.
    p.receiveState(lobby([]));
    p.receiveState(lobby([{ id: 'later', kind: 'agent', name: '小月', text: '迟到的新回复' }]));
    p.renderClock();
    assert.equal(p.calls.some(c => c[0] === 'lobby-narrate'), false);
    choose(p, 'start'); assert.equal(p.calls.filter(c => c === 'start').length, 1);
  }
});

test('a typed start rejection and a synchronous send failure allow a deliberate retry', () => {
  const p = page(); p.receiveState(view({ phase: 'lobby', canStart: true })); choose(p, 'start');
  p.client.lastError = { requestType: 'start', message: '暂不能开启 AI 陪玩' };
  p.handleClientStatus(p.client.lastError.message); assert.equal(p.startRequested, false);
  choose(p, 'start'); assert.equal(p.calls.filter(c => c === 'start').length, 2);
  p.client.lastError = { requestType: 'start', message: '暂不能开启 AI 陪玩' }; p.handleClientStatus(p.client.lastError.message);
  p.client.start = () => { throw new Error('socket unavailable'); };
  choose(p, 'start'); assert.equal(p.startRequested, false);
});

test('actual lobby recognition callback cannot restore a draft after phase change or hide', () => {
  const p = page(); p.onLoad();
  try {
    p.roomId = '0037'; p.data.screen = 'game';
    p.client.options.onState(view({ phase: 'lobby', canStart: true, lobbyChat: { status: 'idle', messages: [] } }));
    const recognizer = { start() {}, abort() {}, stop() {} };
    p.lobbyAudio.createRecognition = () => recognizer;
    choose(p, 'chat'); choose(p, 'chat-mic'); const late = recognizer.onresult;
    p.client.options.onState(view({ phase: 'night' }));
    late({ results: [Object.assign([{ transcript: '这段迟到文字不能恢复' }], { isFinal: true })] });
    assert.equal(p.lobbyTranscript, ''); assert.equal(p.data.chatListening, false);
    p.onHide(); assert.equal(p.lobbyQueue.length, 0); assert.equal(p.lobbySeeded, false);
  } finally { p.onUnload(); }
});
