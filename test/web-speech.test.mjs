import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SpeechPlayback, VoiceInput } from '../web/speech.js';

function playbackHarness(options = {}) {
  const calls = [], done = [], statuses = [], timers = new Map(), voiceListeners = new Set();
  let nextTimer = 0;
  class Utterance { constructor(text) { this.text = text; } }
  const synth = {
    speak(utterance) { calls.push(utterance); },
    cancel() { this.cancels = (this.cancels || 0) + 1; },
    getVoices() { return [{ name: 'Chinese', lang: 'zh-CN' }]; },
    addEventListener(type, callback) { assert.equal(type, 'voiceschanged'); voiceListeners.add(callback); },
    removeEventListener(type, callback) { assert.equal(type, 'voiceschanged'); voiceListeners.delete(callback); },
  };
  const playback = new SpeechPlayback({
    synth, Utterance,
    onDone: (id) => done.push(id), onStatus: (status) => statuses.push(status),
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => timers.delete(id), ...options,
  });
  return { playback, synth, calls, done, statuses, timers, voiceListeners,
    voicesChanged: () => [...voiceListeners].forEach((callback) => callback()),
    finishVoiceWait: () => [...timers.values()].find((timer) => timer.delay === 1200).callback(),
  };
}
const utterance = (id = 'speech-1') => ({ id, name: '晚风', seat: 2, text: '我想先听听大家的看法。' });

test('speech waits for browser completion and acknowledges the authoritative ID once', () => {
  const h = playbackHarness();
  h.playback.play(utterance());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].lang, 'zh-CN');
  assert.equal(h.calls[0].voice.name, 'Chinese');
  assert.equal(h.calls[0].text, '二号发言。我想先听听大家的看法。');
  assert.equal(h.calls[0].rate, 0.92);
  assert.equal(h.calls[0].pitch, 1);
  assert.equal(h.calls[0].volume, 1);
  assert.deepEqual(h.done, []);
  h.calls[0].onstart();
  h.calls[0].onend();
  h.calls[0].onerror();
  assert.deepEqual(h.done, ['speech-1']);
  assert.equal(h.timers.size, 0);
  assert.match(h.statuses.at(-1), /完成/);
});

test('all seats use the same Mandarin voice and never cycle through Cantonese or foreign voices', () => {
  const h = playbackHarness();
  const voices = [
    { name: '香港', lang: 'zh-HK', default: true },
    { name: '澳门', lang: 'zh-MO' },
    { name: 'Cantonese', lang: 'zh-CN' },
    { name: '粤语', lang: 'zh-CN' },
    { name: '粵語', lang: 'zh-TW' },
    { name: 'Chinese Yue', lang: 'yue-Hant-HK' },
    { name: 'English', lang: 'en-US' },
    { name: '臺灣國語', lang: 'zh-TW' },
    { name: '普通话 B', lang: 'zh-CN', voiceURI: 'mandarin-b' },
    { name: '普通话 A', lang: 'zh-CN', voiceURI: 'mandarin-a' },
  ];
  h.synth.getVoices = () => voices;
  for (let seat = 1; seat <= 6; seat++) {
    // Device enumeration order is also not a character-selection mechanism.
    voices.reverse();
    h.playback.play({ ...utterance(`seat-${seat}`), seat });
    const spoken = h.calls.at(-1);
    assert.equal(spoken.voice.voiceURI, 'mandarin-a');
    assert.equal(spoken.pitch, 1);
    assert.equal(spoken.rate, 0.92);
    spoken.onend();
  }
  assert.equal(h.calls.length, 6);
  assert.equal(h.done.length, 6);
});

test('Mandarin BCP 47 and underscore tags are supported without treating every Chinese tag as Mandarin', () => {
  for (const lang of ['cmn-Hans-CN', 'zh-CN', 'zh_Hans_CN', 'cmn', 'zh-SG', 'zh-TW']) {
    const h = playbackHarness();
    const preferred = { name: 'Mandarin', lang };
    h.synth.getVoices = () => [{ name: '粤语', lang: 'zh' }, { name: 'Cantonese', lang: 'zh-HK' }, preferred];
    h.playback.play(utterance());
    assert.equal(h.calls[0].voice, preferred, lang);
    assert.equal(h.calls[0].lang, lang.replaceAll('_', '-'));
    h.calls[0].onend();
  }
});

test('an initially empty voice list waits for voiceschanged then speaks and acknowledges once', () => {
  const h = playbackHarness();
  let voices = [];
  h.synth.getVoices = () => voices;
  h.playback.play(utterance());
  const lateListener = [...h.voiceListeners][0];
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 2);
  assert.deepEqual(h.done, []);
  assert.match(h.statuses.at(-1), /加载普通话/);
  voices = [{ name: '普通话', lang: 'cmn-Hans-CN' }];
  h.voicesChanged();
  assert.equal(h.calls.length, 1);
  assert.equal(h.voiceListeners.size, 0);
  assert.equal(h.timers.size, 1);
  lateListener();
  h.calls[0].onend();
  h.calls[0].onerror();
  lateListener();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.done, ['speech-1']);
  assert.equal(h.timers.size, 0);
});

test('Cantonese-only and unknown voices produce explicit feedback instead of unsafe system-default playback', () => {
  const h = playbackHarness();
  h.synth.getVoices = () => [
    { name: 'HK', lang: 'zh-HK', default: true },
    { name: 'Chinese', lang: 'zh' },
    { name: 'Chinese Yue', lang: 'zh-yue' },
    { name: 'Other Chinese dialect', lang: 'zh-wuu-CN' },
  ];
  h.playback.play(utterance());
  h.voicesChanged();
  assert.equal(h.calls.length, 0);
  h.finishVoiceWait();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.done, ['speech-1']);
  assert.match(h.statuses.at(-1), /未找到普通话.*牌局继续/);
  assert.equal(h.timers.size, 0);
  assert.equal(h.voiceListeners.size, 0);
});

test('voice discovery has a bounded fallback and checks the final available list without an event', () => {
  const h = playbackHarness();
  let voices = [];
  h.synth.getVoices = () => voices;
  delete h.synth.addEventListener;
  h.playback.play(utterance());
  voices = [{ name: '普通话', lang: 'zh-CN' }];
  h.finishVoiceWait();
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 1);
  h.calls[0].onend();
  assert.deepEqual(h.done, ['speech-1']);
  assert.equal(h.timers.size, 0);
});

test('hiding, muting, or leaving during voice discovery cleans up and rejects every late callback', () => {
  for (const stop of [h => h.playback.setHidden(true), h => h.playback.setEnabled(false), h => h.playback.cancel()]) {
    const h = playbackHarness();
    let voices = [];
    h.synth.getVoices = () => voices;
    h.playback.play(utterance());
    const lateListener = [...h.voiceListeners][0];
    const lateTimers = [...h.timers.values()];
    stop(h);
    assert.deepEqual(h.done, ['speech-1']);
    assert.equal(h.timers.size, 0);
    assert.equal(h.voiceListeners.size, 0);
    voices = [{ name: '普通话', lang: 'zh-CN' }];
    lateListener();
    lateTimers.forEach(timer => timer.callback());
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.done, ['speech-1']);
  }
});

test('superseding a pending voice load cannot play or cancel the new speaker through stale callbacks', () => {
  const h = playbackHarness();
  let voices = [];
  h.synth.getVoices = () => voices;
  h.playback.play(utterance());
  const lateListener = [...h.voiceListeners][0];
  const lateTimers = [...h.timers.values()];
  voices = [{ name: '普通话', lang: 'zh-CN' }];
  h.playback.play(utterance('speech-2'));
  const cancels = h.synth.cancels;
  lateListener();
  lateTimers.forEach(timer => timer.callback());
  assert.equal(h.calls.length, 1);
  assert.equal(h.synth.cancels, cancels);
  assert.deepEqual(h.done, ['speech-1']);
  h.calls[0].onend();
  assert.deepEqual(h.done, ['speech-1', 'speech-2']);
});

test('voice loading is inside the 90-second deadline and never restarts it', () => {
  const h = playbackHarness();
  let voices = [];
  h.synth.getVoices = () => voices;
  h.playback.play({ ...utterance(), text: '清晰表达。'.repeat(100) });
  const [deadlineId, deadline] = [...h.timers].find(([, timer]) => timer.delay === 90000);
  voices = [{ name: '普通话', lang: 'zh-CN' }];
  h.voicesChanged();
  assert.equal(h.timers.get(deadlineId), deadline);
  assert.equal(h.timers.size, 1);
  deadline.callback();
  h.calls[0].onend();
  assert.deepEqual(h.done, ['speech-1']);
  assert.equal(h.timers.size, 0);
});

test('spoken text uses neutral seat numbers and narration never invents a player identity', () => {
  const h = playbackHarness();
  const speech = { ...utterance(), text: '2号：我想听3号解释；请说清楚。' };
  h.playback.play(speech);
  assert.equal(h.calls[0].text, '二号发言。我想听三号解释。请说清楚。');
  assert.equal(speech.text, '2号：我想听3号解释；请说清楚。');
  h.calls[0].onend();
  h.playback.play({ ...utterance('narrator'), name: '小月', narration: true, text: '欢迎来到等待大厅。' });
  assert.equal(h.calls[1].text, '欢迎来到等待大厅。');
  h.calls[1].onend();
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

test('timeout cancels old audio before completion can synchronously queue the next reply', () => {
  const h = playbackHarness();
  let stopped = null;
  h.synth.cancel = () => { stopped = h.calls.at(-1); };
  h.playback.onDone = id => {
    h.done.push(id);
    if (id === 'speech-1') h.playback.play(utterance('speech-2'));
  };
  h.playback.play(utterance());
  const first = h.calls[0];
  [...h.timers.values()][0].callback();
  assert.equal(stopped, first);
  assert.equal(h.calls.length, 2);
  assert.equal(h.playback.current.id, 'speech-2');
  first.onend();
  h.calls[1].onend();
  assert.deepEqual(h.done, ['speech-1', 'speech-2']);
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
    .replace(/^import \{ speechText \} from '\.\.\/lib\/speech-text\.js';\n/m, '')
    .replace(/export class /g, 'class ');
  const textSource = fs.readFileSync(new URL('../lib/speech-text.js', import.meta.url), 'utf8')
    .replace(/export function /g, 'function ');
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
    ${textSource}
    ${source}
    const synth = { speak(value) { voices.push(value); }, cancel() {}, getVoices() { return [{ lang: 'zh-CN', name: '普通话' }]; } };
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
