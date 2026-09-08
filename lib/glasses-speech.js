import { speechText } from './speech-text.js';

// AIUI speech APIs are injected so lifecycle tests never require a microphone.
// SpeechSynthesisTask completion means generation ended, not that audio played.
export class GlassesSpeech {
  constructor({ synthesis, Utterance, SpeechPlayer, createRecognition, timers = globalThis,
    createAbortController = () => typeof AbortController === 'function' ? new AbortController() : null,
    onStatus = () => {}, onTranscript = () => {}, onListening = () => {}, onSpeechDone = () => {} }) {
    Object.assign(this, { synthesis, Utterance, SpeechPlayer, createRecognition, timers,
      createAbortController, onStatus, onTranscript, onListening, onSpeechDone });
    this.playGeneration = 0; this.recognitionGeneration = 0; this.muted = false;
    this.completed = new Set(); this.destroyed = false; this.pendingNarration = null;
  }

  startListening() {
    if (this.destroyed) return false;
    this.pendingNarration = null;
    this.stopPlayback('interrupted');
    this.abortListening();
    const generation = ++this.recognitionGeneration;
    try {
      const recognition = this.createRecognition();
      if (!recognition) throw new Error('unavailable');
      this.recognition = recognition;
      recognition.lang = 'zh-CN'; recognition.continuous = false;
      recognition.interimResults = false; recognition.maxAlternatives = 1;
      const current = () => !this.destroyed && generation === this.recognitionGeneration && this.recognition === recognition;
      recognition.onresult = (event) => {
        if (!current()) return;
        const results = event && event.results;
        let text = '';
        for (let i = 0; results && i < results.length; i++) {
          const result = results[i];
          if (result && result.isFinal !== false && result[0] && typeof result[0].transcript === 'string') text += result[0].transcript;
        }
        text = text.trim();
        if (text) {
          this.onTranscript(Array.from(text).slice(0, 240).join(''));
          this.onStatus(Array.from(text).length > 240 ? '已保留前 240 字；请核对后确认发送' : '识别完成；请核对后确认发送');
        }
      };
      recognition.onerror = () => { if (current()) { this.onStatus('语音识别失败；请检查麦克风权限后重试'); this.abortListening(); } };
      recognition.onnomatch = () => { if (current()) this.onStatus('没有识别到文字；可以重录或选择过麦'); };
      recognition.onend = () => {
        if (!current()) return;
        this.releaseRecognition(recognition); this.recognition = null;
        this.clearRecognitionTimer(); this.onListening(false);
      };
      this.onListening(true); this.onStatus('正在识别；说完请停止，再确认文字');
      // This is deliberately synchronous: caller must be a user tap/key event.
      recognition.start();
      if (current()) this.recognitionTimer = this.timers.setTimeout(() => this.stopListening(), 30000);
      return true;
    } catch (_) {
      this.abortListening(); this.onStatus('无法开启语音识别；请在全屏页检查麦克风权限'); return false;
    }
  }

  clearRecognitionTimer() {
    if (this.recognitionTimer !== undefined) this.timers.clearTimeout(this.recognitionTimer);
    this.recognitionTimer = undefined;
  }

  releaseRecognition(recognition) {
    recognition.onresult = null; recognition.onerror = null; recognition.onend = null; recognition.onnomatch = null;
  }

  stopListening() {
    const recognition = this.recognition;
    if (!recognition) return;
    this.clearRecognitionTimer(); this.onStatus('正在结束识别，请稍候');
    const generation = this.recognitionGeneration;
    try { recognition.stop(); } catch (_) { this.abortListening(); return; }
    if (this.recognition === recognition) this.recognitionTimer = this.timers.setTimeout(() => {
      if (generation !== this.recognitionGeneration) return;
      this.abortListening(); this.onStatus('识别已停止；没有文字时可重录或过麦');
    }, 5000);
  }

  abortListening() {
    ++this.recognitionGeneration; this.clearRecognitionTimer();
    const recognition = this.recognition; this.recognition = null;
    if (recognition) { this.releaseRecognition(recognition); try { recognition.abort(); } catch (_) {} }
    this.onListening(false);
  }

  remember(id) {
    this.completed.add(id);
    if (this.completed.size > 80) this.completed.delete(this.completed.values().next().value);
  }

  finish(play, reason) {
    if (!play || play.finished) return;
    play.finished = true;
    if (play.timer !== undefined) this.timers.clearTimeout(play.timer);
    if (play.poll !== undefined) this.timers.clearInterval(play.poll);
    if (play.controller) { try { play.controller.abort(); } catch (_) {} }
    if (play.task) { try { play.task.abort(); } catch (_) {} }
    if (play.player) { try { play.player.stop(); } catch (_) {} try { play.player.destroy(); } catch (_) {} }
    if (this.play === play) this.play = null;
    this.remember(play.id);
    if (reason === 'ended') this.onStatus('发言播放完毕');
    if (reason === 'error' || reason === 'timeout') this.onStatus('语音播放失败，已保留文字；本机跳过播放');
    if (play.kind !== 'narration') this.onSpeechDone(play.id, reason);
    if (this.pendingNarration && ['ended', 'error', 'timeout'].includes(reason)) {
      const narration = this.pendingNarration; this.pendingNarration = null;
      this.narrate(narration);
    }
  }

  stopPlayback(reason = 'interrupted') {
    ++this.playGeneration;
    this.finish(this.play, reason);
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.muted) { this.pendingNarration = null; this.stopPlayback('muted'); }
    this.onStatus(this.muted ? '本机静音；仍可阅读发言' : '下一段发言将自动播放');
  }

  async speak(speech) {
    this.pendingNarration = null;
    return this.playSpeech(speech, 'player');
  }

  async narrate(narration) {
    if (this.destroyed || !narration || !narration.id || !narration.text || this.completed.has(narration.id)) return;
    // Public game speech always has priority; only retain the latest host cue.
    if (this.play && this.play.kind === 'player') { this.pendingNarration = narration; return; }
    if (this.recognition) return;
    return this.playSpeech(narration, 'narration');
  }

  async playSpeech(speech, kind) {
    if (this.destroyed || !speech || typeof speech.id !== 'string' || !speech.id || typeof speech.text !== 'string') return;
    if (this.completed.has(speech.id)) { if (kind === 'player') this.onSpeechDone(speech.id, 'already-played'); return; }
    if (this.play && this.play.id === speech.id) return;
    this.stopPlayback('replaced'); this.abortListening();
    const play = { id: speech.id, kind, generation: this.playGeneration, finished: false, task: null, player: null };
    this.play = play;
    const current = () => !this.destroyed && !play.finished && this.play === play && play.generation === this.playGeneration;
    if (this.muted) { this.finish(play, 'muted'); return; }
    this.onStatus('正在生成发言语音');
    play.timer = this.timers.setTimeout(() => { if (current()) this.finish(play, 'timeout'); }, 90000);
    try {
      const utterance = new this.Utterance(speechText(speech, { narration: kind === 'narration' }));
      // A stable Mandarin news voice avoids dramatic voice changes between seats.
      utterance.voice = 'Chinese (Mandarin)_News_Anchor';
      // Newer AIUI exposes generation speed; the older 0.17 contract does not.
      // Only write an exposed speed control and preserve the host's default pitch.
      if ('rate' in utterance) utterance.rate = 0.92;
      utterance.volume = 1;
      play.controller = this.createAbortController();
      const options = { subtitles: 'none' };
      if (play.controller) options.signal = play.controller.signal;
      const task = await this.synthesis.synthesize(utterance, options);
      // A hide/unload can occur while the host is creating this task.
      if (!current()) {
        if (task.finished && typeof task.finished.catch === 'function') task.finished.catch(() => {});
        try { task.abort(); } catch (_) {} return;
      }
      play.task = task;
      let generated = false;
      Promise.resolve(task.finished).then(() => { if (current()) generated = true; }, () => { if (current()) this.finish(play, 'error'); });
      task.onerror = () => { if (current()) this.finish(play, 'error'); };
      task.onabort = () => { if (current()) this.finish(play, 'error'); };
      play.player = new this.SpeechPlayer(task);
      const started = play.player.play();
      if (started && typeof started.catch === 'function') started.catch(() => { if (current()) this.finish(play, 'error'); });
      if (!current()) return;
      this.onStatus('正在播放发言');
      // Player lifecycle events are not exposed by AIUI. Inspect documented
      // position/duration only after synthesis ended; synthesis alone is not ACK.
      play.poll = this.timers.setInterval(() => {
        if (!current() || !generated) return;
        const duration = Number(play.player.duration), position = Number(play.player.currentTime);
        if (Number.isFinite(duration) && duration > 0 && Number.isFinite(position) && position >= duration) this.finish(play, 'ended');
      }, 150);
    } catch (_) { if (current()) this.finish(play, 'error'); }
  }

  suspend() { this.pendingNarration = null; this.abortListening(); this.stopPlayback('hidden'); }
  destroy() { this.suspend(); this.destroyed = true; }
}
