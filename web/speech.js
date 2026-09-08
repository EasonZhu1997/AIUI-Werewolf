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
    const current = { id: speech.id, finished: false, timer: null, utterance: null };
    this.current = current;
    const finish = (message = '') => {
      if (current.finished) return;
      current.finished = true;
      this.clearTimer(current.timer);
      if (this.current === current) this.current = null;
      if (message) this.onStatus(message);
      this.onDone(current.id);
    };
    current.finish = finish;
    if (!this.enabled || this.hidden) { finish(this.hidden ? '页面已隐藏，请阅读发言' : '已静音，请阅读发言'); return; }
    if (!this.synth || !this.Utterance) { finish('此浏览器不支持朗读，请阅读发言文字'); return; }
    try {
      const utterance = new this.Utterance(`${speech.name}，${speech.text}`);
      current.utterance = utterance;
      utterance.lang = 'zh-CN';
      utterance.rate = 1.03;
      const voices = this.synth.getVoices?.() || [];
      const chinese = voices.filter((voice) => /^zh(?:[-_]|$)/i.test(voice.lang));
      if (chinese.length) utterance.voice = chinese[(Math.max(1, speech.seat || 1) - 1) % chinese.length];
      utterance.onstart = () => { if (!current.finished) this.onStatus(`正在朗读 ${speech.name} 的发言`); };
      utterance.onend = () => finish('朗读完成');
      utterance.onerror = () => finish('朗读未完成，请阅读文字；牌局继续');
      current.timer = this.setTimer(() => {
        finish('朗读超时，请阅读文字；牌局继续');
        try { this.synth.cancel(); } catch { /* Completion is already acknowledged. */ }
      }, Math.min(90000, Math.max(15000, String(speech.text).length * 420 + 8000)));
      this.synth.speak(utterance);
    } catch { finish('无法播放语音，请阅读发言文字'); }
  }

  cancel(message = '') {
    const current = this.current;
    if (current) current.finish(message);
    try { this.synth?.cancel(); } catch { /* Cancellation must remain safe on page exit. */ }
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
