import { SpeechPlayback, VoiceInput } from './speech.js';

export function roomDirectoryEntries(rooms) {
  const seen = new Set();
  return (Array.isArray(rooms) ? rooms : []).filter(room => {
    if (!/^(?:\d{4}|lobby)$/.test(room?.roomId || '') || seen.has(room.roomId)) return false;
    seen.add(room.roomId); return true;
  }).map(room => {
    const members = Math.max(0, Math.min(6, Number(room.members) || 0));
    const online = Math.max(0, Math.min(6, Number(room.online) || 0));
    return { roomId: room.roomId, label: room.roomId === 'lobby' ? '公共大厅' : `房间 ${room.roomId}`, members, online, capacity: 6,
      canJoin: room.canJoin === true && room.phase === 'lobby' && members < 6,
      status: room.phase !== 'lobby' ? room.phase === 'result' ? '正在结算' : '游戏进行中' : members >= 6 ? '座位已满' : '等待开局' };
  });
}

/** Waiting-room dialogue owns its microphone/voice, never a game speech ACK. */
export class LobbyChatController {
  constructor({ onDraft = () => {}, onStatus = () => {}, onVoiceStatus = () => {}, onChange = () => {}, onActive = () => {}, Recognition, synth, Utterance, setTimer, clearTimer } = {}) {
    Object.assign(this, { onDraft, onStatus, onVoiceStatus, onChange, onActive });
    this.session = ''; this.active = false; this.hidden = false; this.needsBaseline = true; this.startRequested = false;
    this.seen = new Set(); this.queue = []; this.messages = []; this.draft = ''; this.error = ''; this.status = 'idle'; this.sending = false; this.lastSent = ''; this.playing = false;
    this.voice = new VoiceInput({ Recognition,
      onText: text => { if (this.active) { this.draft = text; onDraft(text); onChange(); } },
      onStatus: message => { if (this.active) onStatus(message); },
      onActive: listening => { onActive(listening); if (!listening) this.drain(); },
    });
    this.playback = new SpeechPlayback({ synth, Utterance, setTimer, clearTimer,
      onStatus: message => { if (this.active) onVoiceStatus(message); },
      onDone: () => { this.playing = false; this.drain(); },
    });
  }
  get busy() { return this.sending || this.status === 'thinking'; }
  setDraft(text) { this.draft = String(text).slice(0, 240); this.onChange(); }
  sync(view, { connected = true, hidden = false } = {}) {
    const session = view ? `${view.roomId}:${view.selfId}` : '';
    if (session !== this.session) { this.reset(); this.session = session; }
    const isLobby = view?.phase === 'lobby';
    if (!isLobby) this.startRequested = false;
    this.active = Boolean(isLobby && connected && !hidden && !this.startRequested);
    this.hidden = hidden;
    this.playback.hidden = Boolean(hidden);
    if (!this.active) this.suspend();
    if (!isLobby) { this.needsBaseline = true; this.messages = []; this.status = 'idle'; this.onChange(); return; }
    const chat = view.lobbyChat || { messages: [], status: 'idle' };
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    const fresh = messages.filter(message => message?.id && !this.seen.has(message.id));
    for (const message of messages) if (message?.id) this.seen.add(message.id);
    if (this.seen.size > 500) this.seen = new Set(messages.map(message => message.id));
    this.messages = messages;
    this.status = chat.status || 'idle'; this.error = chat.error || '';
    const ownName = view.players?.find(player => player.id === view.selfId)?.name;
    if (this.sending && fresh.some(message => message.kind === 'human' && message.name === ownName && message.text === this.lastSent)) {
      this.sending = false;
      if (this.draft.trim() === this.lastSent) { this.draft = ''; this.onDraft(''); }
    }
    if (this.status === 'error') this.sending = false;
    if (!this.needsBaseline && this.active) this.queue.push(...fresh.filter(message => message.kind === 'agent'));
    this.needsBaseline = !this.active;
    this.onChange(); this.drain();
  }
  drain() {
    if (!this.active || this.hidden || this.playing || this.voice?.active || !this.queue.length) return;
    const message = this.queue.shift(); this.playing = true;
    this.playback.play({ id: `${this.session}:${message.id}`, name: message.name || '小月', text: message.text, narration: true });
  }
  startVoice() {
    if (!this.active) return false;
    this.queue = [];
    if (this.playback.current) this.playback.cancel('语音输入开始，朗读已停止');
    return this.voice.start();
  }
  stopVoice() { this.voice.stop(); }
  submit(send) {
    const text = this.draft.trim();
    if (!this.active || this.busy || !text || text.length > 240) return false;
    this.voice.cancel(); this.sending = true; this.lastSent = text; this.error = '';
    this.onChange();
    try { send(text); return true; }
    catch (error) { this.handleError(error.message || '消息未发送，请重试'); return false; }
  }
  retry(send) {
    if (!this.active || this.busy || !this.lastSent) return false;
    this.draft = this.lastSent; this.onDraft(this.draft); return this.submit(send);
  }
  handleError(message) { this.sending = false; this.error = message; this.onChange(); }
  prepareGame() { this.startRequested = true; this.suspend(); this.onChange(); }
  cancelGameStart() { this.startRequested = false; }
  handleServerError(error) {
    if (!this.startRequested) return { needsSync: false };
    if (error?.requestType === 'start') { this.cancelGameStart(); return { needsSync: false }; }
    // A late chat rejection is not evidence that the separate Start failed.
    // Old servers omit requestType, so keep the lock until state/reconnect proves it.
    return { needsSync: true };
  }
  setEnabled(enabled) { this.playback.setEnabled(enabled); }
  setHidden(hidden) {
    this.hidden = Boolean(hidden);
    if (hidden) { this.active = false; this.suspend(); }
    this.playback.setHidden(hidden);
  }
  suspend() {
    const wasPlaying = Boolean(this.playback.current);
    this.active = false; this.needsBaseline = true; this.queue = []; this.sending = false;
    this.voice.cancel();
    if (this.playback.current) this.playback.cancel('等待区语音已停止');
    this.playing = false; this.draft = ''; this.onDraft('');
    if (wasPlaying) this.onVoiceStatus('等待区语音已停止');
  }
  reset() {
    this.suspend(); this.session = ''; this.seen.clear(); this.messages = []; this.status = 'idle'; this.error = ''; this.lastSent = ''; this.startRequested = false;
  }
}
