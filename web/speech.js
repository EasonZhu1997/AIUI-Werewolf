import { speechText } from '../lib/speech-text.js';

// Voice names and availability belong to the device. Language tags keep Cantonese
// out of a Mandarin game; sorting makes the choice independent of seat and order.
function mandarinVoice(voices) {
  const candidates = [];
  for (const voice of voices) {
    const lang = String(voice.lang || '').replace(/_/g, '-').toLowerCase();
    const name = String(voice.name || '');
    if (/(?:^|-)yue(?:-|$)/.test(lang) || /(?:^|-)(?:hk|mo)(?:-|$)/.test(lang) || /cantonese|粤|粵/i.test(name)) continue;
    let priority = 0;
    // Match known Mandarin tags, not other Chinese extlangs such as zh-wuu-CN.
    if (/^(?:zh|cmn|zh-cmn)(?:-(?:hans|hant))?(?:-(?:cn|sg|tw))?$/.test(lang)) {
      if (/(?:^|-)cn(?:-|$)/.test(lang)) priority = 100;
      else if (/^(?:cmn|zh-cmn)(?:-|$)/.test(lang)) priority = 90;
      else if (/^zh-(?:hans|sg)(?:-|$)/.test(lang)) priority = 80;
      else if (/^zh-(?:tw|hant)(?:-|$)/.test(lang)) priority = 70;
      else if (lang === 'zh' && /mandarin|普通话|普通話|国语|國語/i.test(name)) priority = 60;
    }
    if (priority) candidates.push({ voice, priority, key: `${voice.voiceURI || ''}\n${name}\n${lang}` });
  }
  candidates.sort((a, b) => b.priority - a.priority || Number(Boolean(b.voice.default)) - Number(Boolean(a.voice.default)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return candidates[0]?.voice || null;
}

/** Browser speech is local. Only the confirmed transcript enters the game. */
export class SpeechPlayback {
  constructor({ synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, onDone = () => {}, onStatus = () => {}, setTimer = (callback, delay) => globalThis.setTimeout(callback, delay), clearTimer = (id) => globalThis.clearTimeout(id) } = {}) {
    Object.assign(this, { synth, Utterance, onDone, onStatus, setTimer, clearTimer });
    this.enabled = true;
    this.hidden = false;
    this.seen = new Set();
    this.current = null;
  }

  // Call from the Join / Enable sound user gesture to unlock browser playback.
  unlock() {
    if (!this.synth || !this.Utterance || !this.enabled || this.hidden) return;
    try {
      const utterance = new this.Utterance('');
      utterance.lang = 'zh-CN';
      this.synth.speak(utterance);
    } catch { /* A real utterance reports any failure below. */ }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.cancel('已静音，仍可阅读发言');
    else this.unlock();
  }

  setHidden(hidden) {
    this.hidden = Boolean(hidden);
    if (hidden) this.cancel('页面已隐藏，朗读暂停');
  }

  play(speech) {
    if (!speech?.id || this.seen.has(speech.id)) return;
    this.cancel('');
    this.seen.add(speech.id);
    if (this.seen.size > 300) this.seen.delete(this.seen.values().next().value);
    const current = { id: speech.id, finished: false, timer: null, voiceTimer: null, detachVoices: null, utterance: null };
    this.current = current;
    const stopWaiting = () => {
      if (current.voiceTimer !== null) this.clearTimer(current.voiceTimer);
      current.voiceTimer = null;
      try { current.detachVoices?.(); } catch { /* Cleanup cannot block completion. */ }
      current.detachVoices = null;
    };
    const finish = (message = '', stopAudio = false) => {
      if (current.finished) return;
      current.finished = true;
      stopWaiting();
      if (current.timer !== null) this.clearTimer(current.timer);
      current.timer = null;
      if (this.current === current) this.current = null;
      if (stopAudio) {
        // Completion may synchronously start the next waiting-room reply. Stop
        // this audio first, while its late callbacks are already invalidated.
        try { this.synth?.cancel(); } catch { /* Completion must still be acknowledged. */ }
      }
      if (message) this.onStatus(message);
      this.onDone(current.id);
    };
    current.finish = finish;
    if (!this.enabled || this.hidden) { finish(this.hidden ? '页面已隐藏，请阅读发言' : '已静音，请阅读发言'); return; }
    if (!this.synth || !this.Utterance) { finish('此浏览器不支持朗读，请阅读发言文字'); return; }
    try {
      const text = speechText(speech);
      // This deadline includes voice discovery, so loading cannot extend the
      // server's 90-second completion barrier or leave an utterance unacknowledged.
      current.timer = this.setTimer(() => {
        if (current.finished) return;
        finish('朗读超时，请阅读文字；牌局继续', true);
      }, Math.min(90000, Math.max(15000, text.length * 460 + 8000)));
      const trySpeak = () => {
        if (current.finished || current.utterance || this.current !== current || !this.enabled || this.hidden) return false;
        const voice = mandarinVoice(this.synth.getVoices?.() || []);
        if (!voice) return false;
        stopWaiting();
        const utterance = new this.Utterance(text);
        current.utterance = utterance;
        utterance.lang = String(voice.lang).replace(/_/g, '-');
        utterance.voice = voice;
        utterance.rate = 0.92;
        utterance.pitch = 1;
        utterance.volume = 1;
        utterance.onstart = () => { if (!current.finished) this.onStatus(`正在朗读 ${speech.name || '发言'} · ${voice.name} · 0.92 倍速`); };
        utterance.onend = () => finish('朗读完成');
        utterance.onerror = () => finish('朗读未完成，请阅读文字；牌局继续');
        this.synth.speak(utterance);
        return true;
      };
      if (trySpeak()) return;
      this.onStatus('正在加载普通话语音…');
      const onVoices = () => {
        try { trySpeak(); } catch { finish('无法播放语音，请阅读发言文字'); }
      };
      if (typeof this.synth.addEventListener === 'function') {
        this.synth.addEventListener('voiceschanged', onVoices);
        current.detachVoices = () => this.synth.removeEventListener?.('voiceschanged', onVoices);
      }
      current.voiceTimer = this.setTimer(() => {
        if (current.finished) return;
        try {
          if (!trySpeak()) finish('未找到普通话语音，请在系统中添加普通话语音；本次请阅读文字，牌局继续');
        } catch { finish('无法播放语音，请阅读发言文字'); }
      }, 1200);
      // A voice may have arrived between the first lookup and subscribing.
      onVoices();
    } catch { finish('无法播放语音，请阅读发言文字'); }
  }

  cancel(message = '') {
    const current = this.current;
    if (current) current.finish(message, true);
    else {
      try { this.synth?.cancel(); } catch { /* Cancellation must remain safe on page exit. */ }
    }
  }

  reset() { this.cancel(''); this.seen.clear(); }
}

export class VoiceInput {
  constructor({ Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition, onText = () => {}, onStatus = () => {}, onActive = () => {} } = {}) {
    Object.assign(this, { Recognition, onText, onStatus, onActive });
    this.recognition = null;
    this.generation = 0;
    this.active = false;
  }

  get supported() { return Boolean(this.Recognition); }

  start() {
    this.cancel();
    if (!this.Recognition) { this.onStatus('此浏览器不支持语音转文字，请直接输入发言'); return false; }
    const generation = ++this.generation;
    const recognition = new this.Recognition();
    this.recognition = recognition;
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    this.active = true;
    this.onActive(true);
    recognition.onresult = (event) => {
      if (generation !== this.generation || this.recognition !== recognition) return;
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;
      this.onText(transcript.slice(0, 240));
      this.onStatus('请核对识别文字，确认后再发送');
    };
    recognition.onerror = (event) => {
      if (generation !== this.generation) return;
      this.onStatus(event.error === 'not-allowed' ? '麦克风未获授权，可以直接输入发言' : '语音识别未完成，可以修改文字后发送');
      this.cancel();
    };
    recognition.onend = () => {
      if (generation !== this.generation) return;
      // End invalidates callbacks too: some implementations send a late result.
      this.generation++;
      this.recognition = null;
      this.active = false;
      this.onActive(false);
    };
    try {
      recognition.start();
      this.onStatus('正在听你说话，结束后请核对文字');
      return true;
    } catch {
      this.cancel();
      this.onStatus('麦克风暂时无法启动，请直接输入发言');
      return false;
    }
  }

  stop() {
    // Keep current generation until onend so a final result can be displayed.
    try { this.recognition?.stop(); } catch { this.cancel(); }
  }

  cancel() {
    const recognition = this.recognition;
    this.generation++;
    this.recognition = null;
    this.active = false;
    this.onActive(false);
    try { recognition?.abort(); } catch { /* Ignore a device that already stopped. */ }
  }
}
