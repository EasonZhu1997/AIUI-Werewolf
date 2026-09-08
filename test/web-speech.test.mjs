import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SpeechPlayback, VoiceInput } from '../web/speech.js';

function playbackHarness(options = {}) {
  const calls = [], done = [], statuses = [], timers = new Map();
  let nextTimer = 0;
  class Utterance { constructor(text) { this.text = text; } }
  const synth = {
    speak(utterance) { calls.push(utterance); },
    cancel() { this.cancels = (this.cancels || 0) + 1; },
    getVoices() { return [{ name: 'Chinese', lang: 'zh-CN' }]; },
  };
  const playback = new SpeechPlayback({
    synth, Utterance,
    onDone: (id) => done.push(id), onStatus: (status) => statuses.push(status),
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => timers.delete(id), ...options,
  });
  return { playback, synth, calls, done, statuses, timers };
}
const utterance = (id = 'speech-1') => ({ id, name: '晚风', seat: 2, text: '我想先听听大家的看法。' });

test('speech waits for browser completion and acknowledges the authoritative ID once', () => {
  const h = playbackHarness();
  h.playback.play(utterance());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].lang, 'zh-CN');
  assert.equal(h.calls[0].voice.name, 'Chinese');
  assert.match(h.calls[0].text, /晚风.*我想/);
  assert.deepEqual(h.done, []);
  h.calls[0].onstart();
  h.calls[0].onend();
  h.calls[0].onerror();
  assert.deepEqual(h.done, ['speech-1']);
  assert.equal(h.timers.size, 0);
  assert.match(h.statuses.at(-1), /完成/);
});

test('repeated server snapshots never replay the same speech', () => {
  const h = playbackHarness();
  h.playback.play(utterance());
  h.playback.play(utterance());
  h.calls[0].onend();
  h.playback.play(utterance());
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.done, ['speech-1']);
});

test('muting a current speech cancels and acknowledges, later speeches remain text only', () => {
  const h = playbackHarness();
  h.playback.play(utterance());
  const first = h.calls[0];
  h.playback.setEnabled(false);
  first.onend();
  h.playback.play(utterance('speech-2'));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.done, ['speech-1', 'speech-2']);
  assert.equal(h.timers.size, 0);
  assert.match(h.statuses.at(-1), /静音/);
});

test('page hiding ends current playback and future hidden speech cannot start audio', () => {
  const h = playbackHarness();
  h.playback.play(utterance());
  h.playback.setHidden(true);
  h.playback.play(utterance('speech-2'));
  h.playback.setHidden(false);
  h.playback.play(utterance('speech-3'));
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.done, ['speech-1', 'speech-2']);
  h.calls[1].onend();
  assert.deepEqual(h.done, ['speech-1', 'speech-2', 'speech-3']);
});

test('a stuck browser utterance times out and advances the server only once', () => {
  const h = playbackHarness();
  h.playback.play(utterance());
  const timer = [...h.timers.values()][0];
  assert.ok(timer.delay >= 15000 && timer.delay <= 90000);
  timer.callback();
  h.calls[0].onend();
  assert.deepEqual(h.done, ['speech-1']);
  assert.match(h.statuses.at(-1), /超时/);
  assert.equal(h.timers.size, 0);
});

test('unsupported or broken playback still acknowledges with visible feedback', () => {
  const unavailable = playbackHarness({ synth: null });
  unavailable.playback.play(utterance());
  assert.deepEqual(unavailable.done, ['speech-1']);
  assert.match(unavailable.statuses.at(-1), /不支持/);
  const broken = playbackHarness();
  broken.synth.speak = () => { throw new Error('blocked'); };
  broken.playback.play(utterance());
  assert.deepEqual(broken.done, ['speech-1']);
  assert.match(broken.statuses.at(-1), /无法播放/);
  assert.equal(broken.timers.size, 0);
});

test('superseded playback is canceled before the next speaker and late events are ignored', () => {
  const h = playbackHarness();
  h.playback.play(utterance());
  const first = h.calls[0];
  h.playback.play(utterance('speech-2'));
  first.onend();
  first.onerror();
  assert.deepEqual(h.done, ['speech-1']);
  h.calls[1].onend();
  assert.deepEqual(h.done, ['speech-1', 'speech-2']);
});

test('resume resets seen IDs so the server current utterance can play again', () => {
  const h = playbackHarness();
  h.playback.play(utterance());
  h.playback.reset();
  h.playback.play(utterance());
  assert.equal(h.calls.length, 2);
  assert.equal(h.playback.current.id, 'speech-1');
});

test('default timers keep the Window receiver required by browser native timers', () => {
  // Browser native timers can reject SpeechPlayback as their receiver. Exercise
  // unconfigured defaults in an isolated realm, rather than injecting safe mocks
  // through the constructor (which would hide a broken production default).
  const source = fs.readFileSync(new URL('../web/speech.js', import.meta.url), 'utf8')
    .replace(/export class /g, 'class ');
  const context = vm.createContext({});
  const result = vm.runInContext(`
    const timerReceivers = [], done = [], voices = [];
    globalThis.setTimeout = function (fn, ms) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      timerReceivers.push('set');
      return 101;
    };
    globalThis.clearTimeout = function (id) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      timerReceivers.push('clear');
    };
    ${source}
    const synth = { speak(value) { voices.push(value); }, cancel() {}, getVoices() { return []; } };
    const player = new SpeechPlayback({ synth, Utterance: class { constructor(text) { this.text = text; } }, onDone: id => done.push(id) });
    player.play({ id: 'native-timer-1', seat: 1, name: '声音测试', text: '你好' });
    if (voices.length !== 1) throw new Error('Utterance did not reach synthesis');
    voices[0].onend();
    JSON.stringify({ timerReceivers, done });
  `, context);
  assert.deepEqual(JSON.parse(result), { timerReceivers: ['set', 'clear'], done: ['native-timer-1'] });
});

function recognitionHarness() {
  const instances = [], texts = [], statuses = [], active = [];
  class Recognition {
    constructor() { instances.push(this); this.started = 0; this.aborted = 0; this.stopped = 0; }
    start() { this.started++; }
    stop() { this.stopped++; }
    abort() { this.aborted++; }
  }
  const voice = new VoiceInput({ Recognition, onText: (text) => texts.push(text), onStatus: (status) => statuses.push(status), onActive: (value) => active.push(value) });
  const result = (recognition, text) => recognition.onresult({ results: [[{ transcript: text }]] });
  return { voice, instances, texts, statuses, active, result };
}

test('voice input never opens the microphone on construction', () => {
  const h = recognitionHarness();
  assert.equal(h.instances.length, 0);
  assert.equal(h.voice.active, false);
  h.voice.start();
  assert.equal(h.instances[0].started, 1);
  assert.equal(h.instances[0].lang, 'zh-CN');
});

test('transcript is a bounded draft and is never automatically submitted', () => {
  const h = recognitionHarness();
  h.voice.start();
  h.result(h.instances[0], '我'.repeat(300));
  assert.equal(h.texts[0].length, 240);
  assert.match(h.statuses.at(-1), /核对.*确认/);
});

test('cancel caused by hide, leave, or a changed turn discards late recognition events', () => {
  const h = recognitionHarness();
  h.voice.start();
  const first = h.instances[0];
  h.voice.cancel();
  h.result(first, '不应出现的旧发言');
  first.onerror({ error: 'network' });
  first.onend();
  assert.deepEqual(h.texts, []);
  assert.equal(first.aborted, 1);
  assert.equal(h.voice.active, false);
});

test('a new recording rejects the previous session callbacks', () => {
  const h = recognitionHarness();
  h.voice.start();
  const first = h.instances[0];
  h.voice.start();
  const second = h.instances[1];
  h.result(first, '旧文本');
  first.onend();
  h.result(second, '新文本');
  assert.deepEqual(h.texts, ['新文本']);
  assert.equal(h.voice.active, true);
});

test('manual stop accepts a final transcript until end then rejects late results', () => {
  const h = recognitionHarness();
  h.voice.start();
  const recognition = h.instances[0];
  h.voice.stop();
  assert.equal(recognition.stopped, 1);
  h.result(recognition, '最终文本');
  recognition.onend();
  h.result(recognition, '迟到文本');
  assert.deepEqual(h.texts, ['最终文本']);
  assert.equal(h.voice.active, false);
});

test('microphone denial ends capture and explains text fallback', () => {
  const h = recognitionHarness();
  h.voice.start();
  h.instances[0].onerror({ error: 'not-allowed' });
  assert.equal(h.voice.active, false);
  assert.match(h.statuses.at(-1), /未获授权.*输入/);
  assert.equal(h.instances[0].aborted, 1);
});

test('no recognition implementation gives a useful fallback without opening anything', () => {
  const statuses = [];
  const voice = new VoiceInput({ Recognition: null, onStatus: (message) => statuses.push(message) });
  assert.equal(voice.supported, false);
  assert.equal(voice.start(), false);
  assert.match(statuses[0], /直接输入/);
});
