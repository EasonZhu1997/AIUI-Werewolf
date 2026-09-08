import test from 'node:test';
import assert from 'node:assert/strict';
import { GlassesSpeech } from '../lib/glasses-speech.js';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness({ pending = false, voiceControls = true } = {}) {
  let nextTimer = 0;
  const timeouts = new Map(), intervals = new Map(), calls = [], recognitions = [], players = [];
  const generated = deferred(), creation = deferred();
  const task = { finished: generated.promise, abort() { calls.push('abort-task'); } };
  const timers = { setTimeout(fn) { const id = ++nextTimer; timeouts.set(id, fn); return id; }, clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { const id = ++nextTimer; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); } };
  const audio = new GlassesSpeech({ timers,
    synthesis: { synthesize(utterance, options) { calls.push(['synthesize', utterance, options]); return pending ? creation.promise : Promise.resolve(task); } },
    Utterance: class {
      constructor(text) {
        // Keep both the older 0.17 and newer documented field sets strict, so
        // unsupported assignments cannot silently pass as ordinary JS objects.
        this.text = text; this.lang = 'en-US'; this.voice = null; this.volume = 1;
        if (voiceControls) { this.rate = 1; this.pitch = 1; }
        Object.seal(this);
      }
    },
    SpeechPlayer: class {
      constructor(createdTask) { assert.equal(createdTask, task); this.currentTime = 0; this.duration = 3; players.push(this); }
      play() { calls.push('play'); } stop() { calls.push('stop'); } destroy() { calls.push('destroy'); }
    },
    createRecognition() { const recognition = { start() { calls.push('recognize'); }, stop() { calls.push('stop-recognition'); }, abort() { calls.push('abort-recognition'); } }; recognitions.push(recognition); return recognition; },
    onTranscript(text) { calls.push(['transcript', text]); }, onListening(value) { calls.push(['listening', value]); },
    onSpeechDone(id, reason) { calls.push(['done', id, reason]); }, onStatus(text) { calls.push(['status', text]); }
  });
  return { audio, calls, task, generated, creation, recognitions, players, timeouts, intervals, tick() { [...intervals.values()].forEach((fn) => fn()); } };
}

test('every glasses seat uses the supported Mandarin news voice and normalized spoken text', async () => {
  const labels = ['一', '二', '三', '四', '五', '六'];
  for (let seat = 1; seat <= 6; seat++) {
    const h = harness();
    await h.audio.speak({ id: `seat-${seat}`, seat, text: `${seat}号：先听**4号**发言；再决定投票` });
    const [, utterance, options] = h.calls.find((c) => c[0] === 'synthesize');
    assert.equal(utterance.text, `${labels[seat - 1]}号发言。先听四号发言。再决定投票。`);
    assert.equal(utterance.voice, 'Chinese (Mandarin)_News_Anchor');
    assert.equal(utterance.volume, 1);
    assert.equal(utterance.rate, 0.92);
    assert.equal(utterance.pitch, 1);
    assert.equal(options.subtitles, 'none');
    assert.equal('audio' in options, false);
    assert.equal(options.signal.aborted, false);
    h.audio.suspend();
    assert.equal(options.signal.aborted, true);
  }
});

test('older glasses runtimes keep the news voice without writing unavailable speed or pitch fields', async () => {
  const h = harness({ voiceControls: false });
  await h.audio.speak({ id: 'older-runtime', seat: 2, text: '先听三号发言。' });
  const [, utterance] = h.calls.find((c) => c[0] === 'synthesize');
  assert.equal(utterance.voice, 'Chinese (Mandarin)_News_Anchor');
  assert.equal('rate' in utterance, false);
  assert.equal('pitch' in utterance, false);
  assert.equal(h.players.length, 1);
  h.audio.suspend();
  assert.deepEqual(h.calls.filter((c) => c[0] === 'done'), [['done', 'older-runtime', 'hidden']]);
});

test('glasses host and waiting-room narration use the same voice without a player label', async () => {
  const h = harness();
  await h.audio.narrate({ id: 'host:vote', text: '请1号和2号投票；确认后提交' });
  const [, utterance] = h.calls.find((c) => c[0] === 'synthesize');
  assert.equal(utterance.text, '请一号和二号投票。确认后提交。');
  assert.equal(utterance.voice, 'Chinese (Mandarin)_News_Anchor');
  assert.equal(utterance.rate, 0.92);
  assert.equal(utterance.pitch, 1);
  h.audio.suspend();
  assert.equal(h.calls.filter((c) => c[0] === 'done').length, 0);
});

test('AIUI ACK waits for actual player position after synthesis ends', async () => {
  const h = harness();
  await h.audio.speak({ id: 'one', seat: 2, text: '我还没有足够证据。' });
  assert.equal(h.calls.filter((c) => c === 'play').length, 1);
  h.generated.resolve({ duration: 3 }); await Promise.resolve();
  h.tick(); assert.equal(h.calls.some((c) => c[0] === 'done'), false);
  h.players[0].currentTime = 3; h.tick();
  assert.deepEqual(h.calls.filter((c) => c[0] === 'done'), [['done', 'one', 'ended']]);
  assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 0);
  await h.audio.speak({ id: 'one', seat: 2, text: '重复状态不应重复发言。' });
  assert.equal(h.calls.filter((c) => c === 'play').length, 1);
});

test('player position alone never acknowledges unfinished generation and late events cannot acknowledge twice', async () => {
  const h = harness();
  await h.audio.speak({ id: 'stream', seat: 3, text: '还需要听完这段发言。' });
  h.players[0].currentTime = h.players[0].duration;
  h.tick();
  assert.equal(h.calls.filter((c) => c[0] === 'done').length, 0);
  const lateError = h.task.onerror, lateAbort = h.task.onabort;
  h.generated.resolve({ duration: 3 }); await Promise.resolve(); h.tick();
  lateError(); lateAbort(); h.audio.suspend(); h.tick();
  assert.deepEqual(h.calls.filter((c) => c[0] === 'done'), [['done', 'stream', 'ended']]);
  assert.equal(h.calls.filter((c) => c === 'stop').length, 1);
  assert.equal(h.calls.filter((c) => c === 'destroy').length, 1);
});

test('hide during host synthesis creation aborts late task and never starts audio', async () => {
  const h = harness({ pending: true });
  const speaking = h.audio.speak({ id: 'late', seat: 1, text: '我认为三号值得关注。' });
  h.audio.suspend(); h.creation.resolve(h.task); await speaking;
  assert.equal(h.players.length, 0);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'done'), [['done', 'late', 'hidden']]);
  assert.ok(h.calls.includes('abort-task'));
  assert.equal(h.calls.find((c) => c[0] === 'synthesize')[2].signal.aborted, true);
});

test('muting stops and destroys current player, acknowledges future speech without synthesis', async () => {
  const h = harness();
  await h.audio.speak({ id: 'first', seat: 1, text: '第一段。' });
  h.audio.setMuted(true);
  await h.audio.speak({ id: 'second', seat: 2, text: '第二段。' });
  assert.ok(h.calls.includes('stop')); assert.ok(h.calls.includes('destroy'));
  assert.equal(h.calls.filter((c) => c[0] === 'synthesize').length, 1);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'done'), [['done', 'first', 'muted'], ['done', 'second', 'muted']]);
});

test('recognition only begins on explicit start and returns text without sending game action', () => {
  const h = harness(); assert.equal(h.recognitions.length, 0);
  assert.equal(h.audio.startListening(), true);
  const recognition = h.recognitions[0];
  assert.equal(recognition.lang, 'zh-CN'); assert.equal(recognition.interimResults, false);
  recognition.onresult({ results: [Object.assign([{ transcript: '先听大家发言。' }], { isFinal: true })] });
  assert.deepEqual(h.calls.filter((c) => c[0] === 'transcript'), [['transcript', '先听大家发言。']]);
  assert.equal(h.calls.filter((c) => c[0] === 'done').length, 0);
  h.audio.stopListening(); assert.ok(h.calls.includes('stop-recognition'));
  recognition.onend(); assert.equal(h.timeouts.size, 0); assert.equal(h.audio.recognition, null);
});

test('abort rejects stale recognition events after page hides or phase changes', () => {
  const h = harness(); h.audio.startListening();
  const lateResult = h.recognitions[0].onresult;
  h.audio.suspend();
  lateResult({ results: [Object.assign([{ transcript: '这条不得恢复。' }], { isFinal: true })] });
  assert.equal(h.calls.filter((c) => c[0] === 'transcript').length, 0);
  assert.ok(h.calls.includes('abort-recognition'));
});

test('failed synthesis exposes voice failure and releases playback barrier', async () => {
  const h = harness(); await h.audio.speak({ id: 'bad', seat: 1, text: '测试。' });
  h.generated.reject(new Error('provider unavailable')); await Promise.resolve();
  assert.deepEqual(h.calls.filter((c) => c[0] === 'done'), [['done', 'bad', 'error']]);
  assert.ok(h.calls.some((c) => c[0] === 'status' && c[1].includes('播放失败')));
});

test('playback timeout never reports false success', async () => {
  const h = harness(); await h.audio.speak({ id: 'stalled', seat: 1, text: '测试。' });
  [...h.timeouts.values()][0]();
  assert.deepEqual(h.calls.filter((c) => c[0] === 'done'), [['done', 'stalled', 'timeout']]);
});

test('host narration waits for player speech and never sends a player acknowledgement', async () => {
  const h = harness(); await h.audio.speak({ id: 'player', seat: 2, text: '先听四号发言。' });
  await h.audio.narrate({ id: 'host:vote', text: '现在开始投票。' });
  assert.equal(h.calls.filter((c) => c[0] === 'synthesize').length, 1);
  assert.equal(h.calls.includes('stop'), false);
  h.generated.resolve({ duration: 3 }); await Promise.resolve(); h.players[0].currentTime = 3; h.tick(); await Promise.resolve();
  assert.equal(h.calls.filter((c) => c[0] === 'synthesize').length, 2);
  h.audio.suspend();
  assert.deepEqual(h.calls.filter((c) => c[0] === 'done'), [['done', 'player', 'ended']]);
  assert.equal(h.audio.pendingNarration, null);
});

test('incoming player speech interrupts host narration with no duplicate host ACK', async () => {
  const h = harness(); await h.audio.narrate({ id: 'host:night', text: '天黑请闭眼。' });
  await h.audio.speak({ id: 'player', seat: 2, text: '我会认真观察投票。' });
  assert.ok(h.calls.includes('stop')); assert.ok(h.calls.includes('destroy'));
  assert.equal(h.audio.play.kind, 'player');
  assert.equal(h.calls.filter((c) => c[0] === 'done').length, 0);
  h.audio.suspend();
});

test('hide drops queued host narration and prevents later generation completion from playing it', async () => {
  const h = harness(); await h.audio.speak({ id: 'player', seat: 2, text: '测试玩家发言。' });
  await h.audio.narrate({ id: 'host:vote', text: '现在开始投票。' });
  h.audio.suspend(); h.generated.resolve({ duration: 3 }); await Promise.resolve(); h.tick();
  assert.equal(h.audio.pendingNarration, null);
  assert.equal(h.calls.filter((c) => c[0] === 'synthesize').length, 1);
});
