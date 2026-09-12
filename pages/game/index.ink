<script def>
{
  "navigationBarTitleText": "月下同桌",
  "description": "六人狼人杀全屏游戏。一个真人即可开局，AI 补位并语音发言；四位房间号支持左右摆头输入。只在主动开麦后识别语音，核对文字再发送。身份和线索仅本机显示。",
  "schema": { "data": { "type": "object", "properties": {} } }
}
</script>

<script setup>
import wx from 'wx';
import config from '../../lib/config.js';
import { GameClient } from '../../lib/client.js';
import { RoomDigitInput, PoseDigitControl } from '../../lib/room-input.js';
import { GlassesSpeech } from '../../lib/glasses-speech.js';
import { glassesStage, glassesCountdown } from '../../lib/glasses-stage.js';

const roomLabel = (id) => id === 'lobby' ? '公共大厅' : '房间 ' + id;
const splitPages = (text, size = 66) => {
  const chars = Array.from(String(text || '暂无内容'));
  const pages = [];
  for (let i = 0; i < chars.length; i += size) pages.push(chars.slice(i, i + size).join(''));
  return pages;
};
const short = (text, count) => Array.from(String(text || '')).slice(0, count).join('');
const roleLabel = (role) => ({ wolf: '狼人', seer: '预言家', witch: '女巫', villager: '村民' })[role] || role;

export default {
  data: {
    screen: 'home', version: config.version, menuIndex: 0,
    configured: !!config.url, homeHint: '一个人也能开局，AI 补齐六人同桌',
    cells: [], inputTitle: '', inputStep: '', confirmLabel: '',
    poseHint: '正视前方，保持片刻', directionLabel: '反转左右',
    title: '', phaseLabel: '等待连接', roundLabel: '', roleLine: '身份将在开局后私下显示',
    seats: [], contentTitle: '等待同桌', contentText: '正在连接游戏服务器',
    pageLabel: '', showPaging: false, choiceLabel: '', hasChoices: false,
    actionLabel: '等待状态', actionCount: '', canAct: false,
    notice: '尚未连接', timeLabel: '', listening: false, muted: false,
    stageName: '正在连接', stageBadge: '未同步', stageHint: '连接后显示最新阶段', stageMode: 'offline', stageSteps: [],
    ownTurn: false, stageFlash: false, stageOffset: 0, stageTrace: 0, clockUrgent: false, aliveLabel: '',
    roomRows: [], roomCount: 0, roomPage: '', roomJoinLabel: '选择等待房间', roomCanJoin: false, directoryNotice: '正在加载房间',
    chatListening: false, chatNotice: '',
    instruction: '左右选目标或翻页 · 上下选操作 · 镜腿确认'
  },

  onLoad() {
    this.alive = true; this.foreground = true; this.view = null; this.roomId = null;
    this.editor = null; this.commands = []; this.commandIndex = 0;
    this.choiceIndex = 0; this.pageIndex = 0; this.panel = 'main'; this.transcript = ''; this.storyCapture = false; this.storyTranscript = ''; this.storySentText = '';
    this.promptKey = ''; this.roomEpoch = 0; this.gameEpoch = 0; this.ignoredResumeRoom = null; this.handledResumeError = null; this.resumeInMemory = {};
    this.online = false; this.lastStageTransition = null; this.motionGeneration = 0;
    this.rooms = []; this.roomSelection = 0; this.creating = false;
    this.lobbyEpoch = 0; this.lobbyTranscript = ''; this.lobbySentText = ''; this.lobbySeen = new Set(); this.lobbyQueue = []; this.lobbySeeded = false; this.startRequested = false;
    const timers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
      setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id)
    };
    this.uiTimers = timers;
    this.pose = new PoseDigitControl({ timers,
      createSensor: () => typeof AbsoluteOrientationSensor === 'function' ? new AbsoluteOrientationSensor({ frequency: 30 }) : null,
      onStep: (delta) => { if (this.alive && this.foreground && this.editor && this.data.screen === 'edit') { this.editor.adjust(delta); this.renderInput(); } },
      onStatus: (state) => { if (this.alive) this.setData({ poseHint: state.hint }); }
    });
    // AIUI also exposes speech globally. Some older preview builds cannot import
    // the speech module; missing capabilities must not prevent room UI loading.
    this.audio = new GlassesSpeech({ synthesis: typeof speechSynthesis !== 'undefined' ? speechSynthesis : null,
      Utterance: typeof SpeechSynthesisUtterance === 'function' ? SpeechSynthesisUtterance : null,
      SpeechPlayer: typeof SpeechAudioPlayer === 'function' ? SpeechAudioPlayer : null,
      createRecognition: () => typeof SpeechRecognition === 'function' ? new SpeechRecognition() : null, timers,
      onStatus: (notice) => { if (this.alive) this.setData({ notice: short(notice, 34) }); },
      onTranscript: (text) => {
        if (!this.alive || !this.foreground || !this.view) return;
        if (this.storyCapture && this.view.phase !== 'lobby' && this.view.phase !== 'result') {
          this.storyTranscript = text; this.pageIndex = 0; this.panel = 'story'; this.renderGame(); return;
        }
        if (!this.view.prompt || this.view.prompt.kind !== 'speech') return;
        this.transcript = text; this.pageIndex = 0; this.panel = 'main'; this.renderGame();
      },
      onListening: (listening) => {
        if (!this.alive) return;
        this.setData({ listening });
        if (this.view) this.renderGame();
      },
      onSpeechDone: (id) => { if (this.client) { try { this.client.speechDone(id); } catch (_) {} } }
    });
    this.lobbyAudio = new GlassesSpeech({ synthesis: typeof speechSynthesis !== 'undefined' ? speechSynthesis : null,
      Utterance: typeof SpeechSynthesisUtterance === 'function' ? SpeechSynthesisUtterance : null,
      SpeechPlayer: typeof SpeechAudioPlayer === 'function' ? SpeechAudioPlayer : null,
      createRecognition: () => typeof SpeechRecognition === 'function' ? new SpeechRecognition() : null, timers,
      onStatus: notice => { if (this.alive && this.foreground && this.view && this.view.phase === 'lobby') this.setData({ chatNotice: short(notice, 34), notice: short(notice, 34) }); },
      onTranscript: text => {
        if (!this.alive || !this.foreground || !this.online || !this.view || this.view.phase !== 'lobby' || this.startRequested || this.captureLobbyEpoch !== this.lobbyEpoch || this.captureLobbyRoom !== this.roomId) return;
        this.lobbyTranscript = text; this.panel = 'chat'; this.pageIndex = 0; this.renderGame();
      },
      onListening: value => { if (this.alive) { this.setData({ chatListening: !!value }); if (this.view) this.renderGame(); } },
      // Lobby companion audio is local narration. It must never ACK game speech.
      onSpeechDone: () => {}
    });
    this.client = new GameClient({ url: config.url,
      socketFactory: (url) => wx.connectSocket({ url }),
      onStatus: (status) => this.handleClientStatus(status),
      onWelcome: (welcome) => {
        this.startRequested = false;
        if (this.creating && welcome && /^\d{4}$/.test(welcome.roomId || '')) {
          this.roomId = welcome.roomId; this.creating = false;
          this.setData({ title: roomLabel(this.roomId), contentTitle: '房间已创建', contentText: '把四位房间号告诉朋友，任意一位在线玩家都可以开局。' });
        }
        if (!this.roomId || !welcome || !welcome.resumeToken) return;
        this.resumeInMemory[this.roomId] = welcome.resumeToken; this.ignoredResumeRoom = null;
        try { wx.setStorageSync(this.storageKey(), { resumeToken: welcome.resumeToken }); } catch (_) {}
      },
      onState: (view) => this.receiveState(view),
      onRooms: rooms => this.receiveRooms(rooms)
    });
  },

  onShow() {
    const wasHidden = this.foreground === false;
    this.foreground = true;
    if (wasHidden && this.roomId && this.data.screen === 'game') this.connectRoom();
    if (wasHidden && this.data.screen === 'rooms') this.refreshDirectory();
  },
  onHide() {
    this.foreground = false;
    if (this.creating) { this.creating = false; this.setData({ canAct: true, actionLabel: '重新创建房间' }); }
    this.online = false; this.stopClock(); this.stopStageMotion();
    this.stopLobbyChat();
    if (this.pose) this.pose.stop();
    if (this.audio) this.audio.suspend();
    if (this.client) this.client.disconnect();
    if (this.alive) this.setData({ notice: '已暂停音频；返回后恢复座位', listening: false });
  },
  onUnload() {
    this.foreground = false;
    this.online = false; this.stopClock(); this.stopStageMotion();
    this.stopLobbyChat(); if (this.lobbyAudio) this.lobbyAudio.destroy();
    if (this.pose) this.pose.stop();
    if (this.audio) this.audio.destroy();
    if (this.client) this.client.disconnect();
    if (this.editor) this.editor.clear();
    this.alive = false;
  },

  storageKey() { return 'werewolf.resume.v1:' + config.url + ':' + this.roomId; },
  handleClientStatus(status) {
    if (!this.alive) return;
    this.setData({ notice: short(status, 34) });
    if (this.data.screen === 'rooms') this.setData({ directoryNotice: short(status, 34) });
    if (/^(正在连接|连接已断开|连接失败)/.test(status)) {
      this.online = false; this.stopClock(); this.stopStageMotion();
      this.stopLobbyChat();
      if (this.audio) this.audio.suspend();
      if (this.view) this.renderGame();
    }
    const error = this.client && this.client.lastError;
    // A delayed chat error is not a rejection of the pending start request.
    // Older services omit requestType; keep the lock until a fresh room sync.
    if (error) { if (error.requestType === 'start') this.startRequested = false; this.lobbySentText = ''; if (this.view && this.view.phase === 'lobby') this.renderGame(); }
    if (this.creating && (error || /^(连接已断开|连接失败)/.test(status))) {
      this.creating = false; this.setData({ canAct: true, actionLabel: '重新创建房间' });
    }
    if (!this.roomId || !error || error.code !== 'RESUME_EXPIRED' || error === this.handledResumeError) return;
    this.handledResumeError = error;
    this.ignoredResumeRoom = this.roomId;
    if (this.resumeInMemory) delete this.resumeInMemory[this.roomId];
    try { wx.removeStorageSync(this.storageKey()); } catch (_) {}
    this.audio.suspend(); this.audio.completed.clear(); this.view = null; this.transcript = ''; this.promptKey = '';
    this.setData({ phaseLabel: '重新入座', roleLine: '旧座位已失效，正在重新入座', seats: [],
      contentTitle: '原对局已结束或服务已重启', contentText: '正在用当前房间号重新入座。如果本桌已开局或满员，可以离开并使用另一个房间号。',
      choiceLabel: '', hasChoices: false, showPaging: false, timeLabel: '', notice: '旧记录已清除，正在重新入座' });
    this.commands = [{ id: 'reconnect', label: '重连房间' }, { id: 'leave', label: '离开房间' }]; this.commandIndex = 0;
    this.setData({ actionLabel: '重连房间', actionCount: '1/2', canAct: true });
    if (this.foreground) this.connectRoom();
  },
  openEditor() {
    if (!this.foreground) return;
    this.editor = new RoomDigitInput(); this.setData({ screen: 'edit' }); this.renderInput();
    this.pose.start();
  },
  createRoom() {
    if (!this.foreground || this.creating) return;
    if (!config.url) { this.setData({ homeHint: '尚未配置服务器，请先配置并重新打包' }); return; }
    this.enterRoomScreen(null); this.creating = true;
    this.setData({ title: '创建房间', contentTitle: '正在生成房间号', contentText: '创建成功后会显示四位房号。朋友可从等待大厅或输入房号加入。', actionLabel: '正在创建房间', actionCount: '1/2', canAct: false });
    this.commands = [{ id: 'create', label: '重新创建房间' }, { id: 'leave', label: '返回首页' }]; this.commandIndex = 0;
    try { this.client.create({ name: '眼镜玩家' }); } catch (_) { this.creating = false; this.setData({ notice: '创建失败，请重试', canAct: true, actionLabel: '重新创建房间' }); }
  },
  openDirectory() {
    if (!this.foreground) return;
    this.stopLobbyChat(); this.pose.stop(); this.audio.suspend(); this.client.disconnect();
    this.view = null; this.roomId = null; this.creating = false; this.rooms = []; this.roomSelection = 0;
    this.setData({ screen: 'rooms', roomRows: [], roomCount: 0, roomPage: '', roomCanJoin: false, roomJoinLabel: '等待房间列表', directoryNotice: '正在连接等待大厅' });
    this.refreshDirectory();
  },
  refreshDirectory() {
    if (!this.foreground || this.data.screen !== 'rooms') return;
    try { if (this.client.socket && this.client.mode === 'rooms') this.client.refreshRooms(); else this.client.browse(); }
    catch (_) { this.setData({ directoryNotice: '列表暂不可用，请刷新重试' }); }
  },
  receiveRooms(rooms) {
    if (!this.alive || !this.foreground || this.data.screen !== 'rooms') return;
    const previous = this.rooms && this.rooms[this.roomSelection];
    this.rooms = (Array.isArray(rooms) ? rooms : []).filter(room => /^(?:\d{4}|lobby)$/.test(room.roomId || '')).slice(0, 100);
    this.roomSelection = Math.max(0, previous ? this.rooms.findIndex(room => room.roomId === previous.roomId) : 0);
    this.renderDirectory();
  },
  renderDirectory() {
    const rooms = this.rooms || []; const selected = rooms[this.roomSelection];
    const start = Math.floor(this.roomSelection / 3) * 3;
    this.setData({ roomRows: rooms.slice(start, start + 3).map((room, index) => ({ id: room.roomId, title: roomLabel(room.roomId), selected: start + index === this.roomSelection,
      detail: room.canJoin ? '等待中 · ' + room.members + '/6 席 · ' + room.online + ' 人在线' : room.phase === 'lobby' ? '等待中 · 座位已满' : '对局进行中 · 暂不可加入' })),
      roomCount: rooms.length, roomPage: rooms.length ? (this.roomSelection + 1) + '/' + rooms.length : '暂无房间',
      roomCanJoin: !!(selected && selected.canJoin), roomJoinLabel: selected ? selected.canJoin ? '加入 ' + roomLabel(selected.roomId) : '此房间暂不可加入' : '暂无等待房，可创建一间',
      directoryNotice: rooms.length ? '上下选择 · 镜腿加入 · 右键刷新' : '还没有等待中的房间，创建一间邀请朋友吧' });
  },
  previousRoom() { this.moveRoom(-1); },
  nextRoom() { this.moveRoom(1); },
  moveRoom(delta) { if (this.rooms && this.rooms.length) { this.roomSelection = (this.roomSelection + delta + this.rooms.length) % this.rooms.length; this.renderDirectory(); } },
  joinSelectedRoom() { const room = this.rooms && this.rooms[this.roomSelection]; if (room && room.canJoin) this.enterRoom(room.roomId); else this.setData({ directoryNotice: '请选择仍可加入的等待房间' }); },
  closeDirectory() { this.client.disconnect(); this.rooms = []; this.setData({ screen: 'home', menuIndex: 1 }); },
  enterLobby() { this.enterRoom('lobby'); },
  renderInput() { if (this.editor) this.setData(this.editor.view()); },
  decrementDigit() { this.changeDigit(-1); },
  incrementDigit() { this.changeDigit(1); },
  changeDigit(delta) {
    if (!this.editor) return;
    this.pose.suppress(); this.editor.adjust(delta); this.renderInput();
  },
  confirmDigit() {
    if (!this.editor) return;
    this.pose.suppress();
    if (this.editor.confirm()) this.enterRoom(this.editor.result().roomId);
    else this.renderInput();
  },
  previousDigit() {
    if (!this.editor) return;
    this.pose.suppress();
    if (this.editor.back()) this.renderInput(); else this.cancelInput();
  },
  cancelInput() {
    this.pose.stop(); if (this.editor) this.editor.clear(); this.editor = null;
    this.setData({ screen: 'home', cells: [] });
  },
  calibratePose() { if (this.foreground && this.editor) this.pose.start(); },
  reverseDirection() { if (this.editor) this.setData({ directionLabel: this.pose.reverse() < 0 ? '恢复左右' : '反转左右' }); },
  enterRoom(id) {
    if (!this.foreground) return;
    if (!config.url) { this.setData({ homeHint: '尚未配置服务器，请先配置并重新打包', poseHint: '尚未配置服务器，请先配置并重新打包' }); return; }
    this.enterRoomScreen(id); this.connectRoom();
  },
  enterRoomScreen(id) {
    this.stopLobbyChat(); this.creating = false;
    this.pose.stop(); if (this.editor) this.editor.clear(); this.editor = null;
    this.audio.suspend(); this.audio.completed.clear(); this.client.disconnect(); this.view = null;
    this.online = false; this.stopClock(); this.stopStageMotion(); this.lastStageTransition = null;
    this.roomId = id; ++this.roomEpoch; this.transcript = ''; this.storyCapture = false; this.storyTranscript = ''; this.storySentText = ''; this.lastStoryId = ''; this.panel = 'main'; this.promptKey = '';
    this.setData({ screen: 'game', title: roomLabel(id), cells: [], roleLine: '身份将在开局后私下显示',
      seats: [], phaseLabel: '等待连接', contentTitle: '正在入座', contentText: '其他设备输入相同房间号即可同桌',
      actionLabel: '重连房间', canAct: true, timeLabel: '', choiceLabel: '', hasChoices: false, showPaging: false });
    this.setData(glassesStage(null, { connected: false }));
    this.commands = [{ id: 'reconnect', label: '重连房间' }, { id: 'leave', label: '离开房间' }]; this.commandIndex = 0;
  },
  connectRoom() {
    if (!this.roomId || !this.foreground) return;
    let resumeToken;
    if (this.ignoredResumeRoom !== this.roomId) {
      resumeToken = this.resumeInMemory && this.resumeInMemory[this.roomId];
      if (!resumeToken) { try { const saved = wx.getStorageSync(this.storageKey()); resumeToken = saved && saved.resumeToken; } catch (_) {} }
    }
    try { this.client.join({ roomId: this.roomId, name: '眼镜玩家', resumeToken, createIfMissing: false }); }
    catch (_) { this.setData({ notice: '连接失败，请选择重连房间' }); }
  },
  leaveRoom() {
    this.stopLobbyChat(); this.creating = false;
    this.online = false; this.stopClock(); this.stopStageMotion(); this.lastStageTransition = null;
    this.audio.suspend(); this.pose.stop();
    try { this.client.leave(); } catch (_) { this.client.disconnect(); }
    // An active game keeps the human seat on the server; retain its credential
    // so re-entering the room can recover that seat. Lobby leave removes it.
    if (this.roomId && this.view && this.view.phase === 'lobby') {
      if (this.resumeInMemory) delete this.resumeInMemory[this.roomId];
      try { wx.removeStorageSync(this.storageKey()); } catch (_) {}
    }
    this.roomId = null; this.view = null; this.transcript = ''; this.promptKey = '';
    this.commands = []; this.setData({ screen: 'home', cells: [], homeHint: '一个人也能开局，AI 补齐六人同桌', listening: false });
  },

  receiveState(view) {
    if (!this.alive || !this.foreground || !view || view.roomId !== this.roomId) return;
    if (view.phase === 'lobby' && (!this.view || this.view.phase !== 'lobby')) { this.gameEpoch = (this.gameEpoch || 0) + 1; this.startRequested = false; }
    if (view.phase !== 'lobby') this.stopLobbyChat();
    this.online = true; this.startClock();
    const prompt = view.prompt;
    const key = view.round + ':' + view.phase + ':' + (prompt ? prompt.kind + ':' + JSON.stringify(prompt.choices || []) : '');
    const changed = key !== this.promptKey;
    this.view = view;
    if (view.storyChat && view.storyChat.status !== 'thinking' && this.storySentText) {
      if (view.storyChat.status === 'idle') this.storyTranscript = '';
      this.storySentText = '';
    }
    if (view.phase === 'lobby') this.receiveLobbyChat(view.lobbyChat);
    if (changed) {
      this.promptKey = key; this.transcript = ''; this.storyCapture = false; this.storyTranscript = ''; this.choiceIndex = 0; this.pageIndex = 0;
      this.commandIndex = 0; this.panel = 'main'; this.audio.abortListening();
    }
    if (!view.speech || view.speech.id !== (this.lastSpeechId || '')) this.pageIndex = 0;
    this.lastSpeechId = view.speech && view.speech.id;
    this.renderGame(changed);
    if (view.speech) this.audio.speak(view.speech);
    else {
      if (this.audio.play && this.audio.play.kind === 'player') this.audio.stopPlayback('phase-ended');
      this.narratePhase(view); this.narrateStory(view);
    }
  },
  narratePhase(view) {
    let cue = null;
    if (view.phase === 'night') cue = '第 ' + view.round + ' 夜，天黑请闭眼。请根据屏幕提示完成夜间行动。';
    if (view.phase === 'speech') cue = '天亮了。现在按照座位顺序发言，请听取大家的判断。';
    if (view.phase === 'vote') cue = '现在开始放逐投票。请选择你怀疑的玩家，也可以弃票。';
    if (view.phase === 'result') cue = '本局结束。' + (view.result && view.result.reason || '请查看对局结果。');
    if (cue) this.audio.narrate({ id: 'host:' + this.roomEpoch + ':' + (this.gameEpoch || 0) + ':' + view.round + ':' + view.phase, text: cue });
  },
  narrateStory(view) {
    const messages = view.story && Array.isArray(view.story.messages) ? view.story.messages : [];
    const latest = messages[messages.length - 1];
    if (!latest || latest.kind !== 'host' || latest.id === this.lastStoryId) return;
    this.lastStoryId = latest.id;
    this.audio.narrate({ id: 'story:' + this.roomEpoch + ':' + latest.id, text: latest.text });
  },
  stopLobbyChat() {
    this.lobbyEpoch = (this.lobbyEpoch || 0) + 1; this.lobbyTranscript = ''; this.lobbySentText = ''; this.lobbyQueue = [];
    this.lobbySeen = new Set(); this.lobbySeeded = false; this.captureLobbyRoom = null;
    if (this.lobbyAudio) this.lobbyAudio.suspend();
    if (this.alive) this.setData({ chatListening: false, chatNotice: '' });
  },
  receiveLobbyChat(chat) {
    const messages = chat && Array.isArray(chat.messages) ? chat.messages : [];
    if (!this.lobbySeen) this.lobbySeen = new Set();
    for (const message of messages) {
      if (!message || !message.id || typeof message.text !== 'string') continue;
      if (this.lobbySeeded && !this.lobbySeen.has(message.id) && message.kind === 'human' && message.text === this.lobbySentText) {
        if (this.lobbyTranscript === this.lobbySentText) this.lobbyTranscript = '';
        this.lobbySentText = '';
      }
      if (this.lobbySeeded && !this.startRequested && !this.lobbySeen.has(message.id) && message.kind === 'agent') this.lobbyQueue.push(message);
      this.lobbySeen.add(message.id);
    }
    this.lobbySeeded = true;
    if (this.lobbySeen.size > 200) this.lobbySeen = new Set(messages.map(message => message.id));
    this.pumpLobbyReply();
  },
  pumpLobbyReply() {
    if (!this.alive || !this.foreground || !this.online || this.startRequested || !this.view || this.view.phase !== 'lobby' || !this.lobbyAudio || this.lobbyAudio.play || this.data.chatListening || !this.lobbyQueue || !this.lobbyQueue.length) return;
    const message = this.lobbyQueue.shift();
    this.lobbyAudio.narrate({ id: 'lobby:' + this.roomEpoch + ':' + message.id, text: (message.name || '小月') + '：' + message.text });
  },
  renderClock() {
    if (!this.alive || !this.foreground) return;
    this.setData(glassesCountdown(this.view, { connected: this.online }));
    this.pumpLobbyReply();
  },
  startClock() {
    if (!this.uiTimers || this.clock !== undefined || !this.alive || !this.foreground) return;
    this.clock = this.uiTimers.setInterval(() => this.renderClock(), 500);
  },
  stopClock() {
    if (this.uiTimers && this.clock !== undefined) this.uiTimers.clearInterval(this.clock);
    this.clock = undefined;
  },
  stopStageMotion() {
    this.motionGeneration = (this.motionGeneration || 0) + 1;
    if (this.uiTimers) {
      if (this.motionStart !== undefined) this.uiTimers.clearTimeout(this.motionStart);
      if (this.motionEnd !== undefined) this.uiTimers.clearTimeout(this.motionEnd);
    }
    this.motionStart = undefined; this.motionEnd = undefined;
    if (this.alive) this.setData({ stageFlash: false, stageOffset: 0, stageTrace: 0 });
  },
  updateStage(view) {
    const stage = glassesStage(view, { connected: this.online, listening: this.data.listening, transcript: this.transcript, muted: this.data.muted });
    this.setData(stage);
    const key = this.roomEpoch + ':' + this.gameEpoch + ':' + stage.transitionKey;
    if (key === this.lastStageTransition) return;
    this.lastStageTransition = key;
    this.stopStageMotion();
    if (!this.uiTimers || !this.alive || !this.foreground || !this.online) return;
    const generation = this.motionGeneration;
    this.setData({ stageFlash: true, stageOffset: -3, stageTrace: 0 });
    // Supported WXSS transitions provide the motion; no animation/keyframes or
    // continuous render loop. Short timers are cleared on hide/unload/leave.
    this.motionStart = this.uiTimers.setTimeout(() => {
      if (!this.alive || !this.foreground || generation !== this.motionGeneration) return;
      this.motionStart = undefined; this.setData({ stageOffset: 0, stageTrace: 100 });
    }, 60);
    this.motionEnd = this.uiTimers.setTimeout(() => {
      if (!this.alive || !this.foreground || generation !== this.motionGeneration) return;
      this.motionEnd = undefined; this.setData({ stageFlash: false, stageTrace: 0 });
    }, 1250);
  },
  renderGame(reset = false) {
    const view = this.view; if (!view || !this.alive) return;
    this.updateStage(view);
    if (!this.online) {
      this.commands = [{ id: 'reconnect', label: '重连并同步阶段' }, { id: 'leave', label: '离开房间' }]; this.commandIndex = 0;
      this.setData({ roleLine: '身份与阶段等待重新同步', aliveLabel: '', contentTitle: '本机连接已断开',
        contentText: '其他玩家可能继续对局。请重连获取最新阶段，不要依据离线画面行动。',
        actionLabel: this.commands[0].label, actionCount: '1/2', canAct: true, hasChoices: false, choiceLabel: '', showPaging: false, pageLabel: '' });
      this.renderClock(); return;
    }
    const prompt = view.prompt, choices = prompt && prompt.choices || [];
    if (this.choiceIndex >= choices.length) this.choiceIndex = 0;
    const own = (view.players || []).find((player) => player.id === view.selfId);
    let title, body;
    if (this.panel === 'chat' && view.phase === 'lobby') {
      const chat = view.lobbyChat || { messages: [], status: 'idle' };
      const messages = chat.messages || [];
      title = this.lobbySentText ? '聊天已提交 · 等待确认' : this.lobbyTranscript ? chat.status === 'thinking' ? '小月回复中 · 草稿已保留' : '核对聊天草稿 · 确认才发送' : this.data.chatListening ? '正在听你说话' : chat.status === 'thinking' ? '小月正在回复 · 仍可开局' : chat.status === 'error' ? '小月暂时未能回复' : '小月 · 最新消息在前';
      body = this.lobbyTranscript || (chat.status === 'error' ? chat.error || '请稍后重试，也可以直接开局。' : messages.length ? messages.slice(-6).reverse().map(message => message.name + '：' + message.text).join('；') : '小月会陪大家聊聊。选择“和小月说话”后开麦，先核对文字，再确认发送。小月不占游戏座位。');
    } else if (this.panel === 'story' && view.phase !== 'lobby') {
      const story = view.story || { messages: [] };
      const messages = Array.isArray(story.messages) ? story.messages : [];
      const chat = view.storyChat || { status: 'idle' };
      title = this.storyTranscript ? '核对给城主的话' : chat.status === 'thinking' ? '城主正在续写' : '地下城城主';
      body = this.storyTranscript || (messages.length ? messages.slice(-7).reverse().map(message => (message.kind === 'host' ? '城主' : message.name) + '：' + message.text).join('；') : '城主正在点亮第一盏灯。选择“与城主对话”，说出你看见的线索、疑问或下一步想法。');
    } else if (this.panel === 'clues') {
      title = '仅自己可见 · 身份线索';
      body = (view.self ? '你的身份：' + view.self.roleName + '。' : '') + ((view.self && view.self.clues || []).join('；') || '目前没有额外线索。');
    } else if (this.panel === 'players') {
      title = '同桌座位';
      body = (view.players || []).map((player) => player.seat + '号 ' + player.name + (player.bot ? ' AI' : ' 真人') + (player.alive ? '' : ' 已出局') + (player.connected || player.bot ? '' : ' 离线') + (player.role ? ' ' + roleLabel(player.role) : '')).join('；');
    } else if (this.panel === 'history') {
      title = '公开记录'; body = (view.logs || []).map((log) => log.text).join('；') || '本桌尚无记录';
    } else if (view.phase === 'result') {
      title = '本局结束'; body = (view.result ? view.result.reason : '对局已结束') + '。选择“同桌座位”查看全部身份。';
    } else if (view.speech) {
      title = view.speech.seat + ' 号发言 · ' + view.speech.name; body = view.speech.text;
    } else if (prompt && prompt.kind === 'speech') {
      title = this.transcript ? '核对文字 · 确认才会发送' : '轮到你发言';
      body = this.transcript || '选择“开始说话”后开启麦克风。语音先转文字，核对确认后全桌朗读，也可以过麦。';
    } else if (prompt) {
      title = prompt.label; body = choices.length ? (prompt.kind === 'vote' ? '左右选择放逐对象或弃票，再按镜腿确认。全桌投完后公布票数。' : '左右选择目标或操作，再按镜腿确认。你的夜间选择只对自己显示。') : '请等待其他玩家完成操作。';
    } else if (view.phase === 'lobby') {
      title = '等待朋友 · 随时可开局';
      body = '任意在线玩家都可开局，AI 会补齐空位。等待时选择“和小月聊聊”，可用语音聊天，小月不占座位。';
    } else {
      title = view.phaseLabel;
      body = own && !own.alive ? '你已出局，可以继续旁观、听发言和查看公开记录。' : '暂时无需操作，请等待当前环节完成。';
    }
    const pages = splitPages(body);
    this.pageIndex = Math.min(Math.max(0, this.pageIndex), pages.length - 1);
    this.pageTotal = pages.length;
    const oldCommand = !reset && this.commands[this.commandIndex] && this.commands[this.commandIndex].id;
    const commands = [];
    if (this.panel !== 'main') {
      commands.push({ id: 'main', label: '返回当前回合' });
      if (this.panel === 'story' && view.phase !== 'lobby' && view.phase !== 'result') {
        const storyChat = view.storyChat || { status: 'idle' };
        if (this.storyTranscript && !this.data.listening && !this.storySentText && storyChat.status !== 'thinking') commands.unshift({ id: 'story-send', label: '确认发给城主' });
        commands.push({ id: this.data.listening ? 'story-stop' : 'story-mic', label: this.data.listening ? '停止城主识别' : this.storyTranscript ? '重新说给城主听' : '和城主说话' });
      }
    } else if (view.canStart) commands.push({ id: 'start', label: '开局 · AI 补位' });
    else if (view.canRestart) commands.push({ id: 'restart', label: '再来一局' });
    else if (prompt && prompt.kind === 'speech') {
      commands.push({ id: this.data.listening ? 'stop-mic' : 'mic', label: this.data.listening ? '停止识别' : this.transcript ? '重新说话' : '开始说话' });
      if (this.transcript && !this.data.listening) commands.unshift({ id: 'send', label: '确认文字并发送' });
      commands.push({ id: 'pass', label: '本轮过麦' });
    } else if (prompt && choices.length) commands.push({ id: 'choose', label: '确认：' + short(choices[this.choiceIndex].label, 14) });
    if (view.phase === 'lobby') {
      if (this.panel === 'chat') {
        if (this.lobbyTranscript && !this.data.chatListening && !this.lobbySentText && (!view.lobbyChat || view.lobbyChat.status !== 'thinking')) commands.unshift({ id: 'chat-send', label: '确认文字发给小月' });
        commands.push({ id: this.data.chatListening ? 'chat-stop' : 'chat-mic', label: this.data.chatListening ? '停止聊天识别' : this.lobbyTranscript ? '重新说给小月听' : '和小月说话' });
        if (view.canStart) commands.push({ id: 'start', label: '现在开局 · AI 补位' });
      } else commands.push({ id: 'chat', label: '和小月聊聊' });
    } else if (view.phase !== 'result') {
      commands.push({ id: 'story', label: '与城主对话' });
    }
    if (pages.length > 1) commands.push({ id: 'next-page', label: '下一页文字' });
    commands.push({ id: 'clues', label: '查看身份线索' }, { id: 'players', label: '同桌座位' }, { id: 'history', label: '公开记录' },
      { id: 'mute', label: this.data.muted ? '开启发言语音' : '本机静音' }, { id: 'reconnect', label: '重连房间' }, { id: 'leave', label: '离开房间' });
    this.commands = commands;
    this.commandIndex = Math.max(0, oldCommand ? commands.findIndex((command) => command.id === oldCommand) : 0);
    const selected = commands[this.commandIndex];
    this.setData({ title: roomLabel(view.roomId), phaseLabel: short(view.phaseLabel, 16),
      roleLine: view.self ? view.selfSeat + ' 号 · ' + view.self.roleName + (own && !own.alive ? ' · 已出局' : ' · 仅自己可见') : '身份将在开局后私下显示',
      seats: (view.players || []).map((player) => ({ seat: player.seat, label: player.seat + (player.bot ? ' AI' : ' 人'), alive: player.alive, own: player.id === view.selfId })),
      aliveLabel: view.phase === 'lobby' ? view.players.length + '/6 已入座' : (view.players || []).filter(player => player.alive).length + '/6 存活',
      contentTitle: short(title, 24), contentText: pages[this.pageIndex], showPaging: pages.length > 1, pageLabel: (this.pageIndex + 1) + '/' + pages.length,
      hasChoices: this.panel === 'main' && choices.length > 0, choiceLabel: choices.length ? (this.choiceIndex + 1) + '/' + choices.length + '  ' + choices[this.choiceIndex].label : '',
      actionLabel: selected.label, actionCount: (this.commandIndex + 1) + '/' + commands.length, canAct: true });
    this.renderClock();
  },
  previousAction() { this.moveAction(-1); },
  nextAction() { this.moveAction(1); },
  moveAction(delta) {
    if (!this.commands.length) return;
    this.commandIndex = (this.commandIndex + delta + this.commands.length) % this.commands.length;
    this.setData({ actionLabel: this.commands[this.commandIndex].label, actionCount: (this.commandIndex + 1) + '/' + this.commands.length });
  },
  previousContent() { this.moveContent(-1); },
  nextContent() { this.moveContent(1); },
  moveContent(delta) {
    const choices = this.view && this.view.prompt && this.view.prompt.choices || [];
    if (this.panel === 'main' && choices.length) {
      this.choiceIndex = (this.choiceIndex + delta + choices.length) % choices.length;
    } else if (this.pageTotal > 1) this.pageIndex = (this.pageIndex + delta + this.pageTotal) % this.pageTotal;
    else { this.moveAction(delta); return; }
    this.renderGame();
  },
  activateAction() {
    if (!this.foreground) return;
    const command = this.commands[this.commandIndex]; if (!command) return;
    const id = command.id, view = this.view;
    try {
      if (id === 'start') { if (this.startRequested) return; this.startRequested = true; this.stopLobbyChat(); this.client.start(); }
      else if (id === 'restart') this.client.restart();
      else if (id === 'choose' && view && view.prompt) {
        const choice = view.prompt.choices[this.choiceIndex];
        if (choice) this.client.sendAction({ kind: view.prompt.kind, target: choice.target, action: choice.action });
      } else if (id === 'mic') {
        this.transcript = ''; this.pageIndex = 0; this.audio.startListening(); this.renderGame();
      } else if (id === 'stop-mic') this.audio.stopListening();
      else if (id === 'send' && this.transcript && !this.data.listening) {
        this.client.sendAction({ kind: 'speech', text: this.transcript });
      } else if (id === 'pass') {
        this.audio.abortListening(); this.client.sendAction({ kind: 'speech', text: '本轮过麦。' });
      } else if (id === 'mute') { const muted = !this.data.muted; this.setData({ muted }); this.audio.setMuted(muted); if (this.lobbyAudio) this.lobbyAudio.setMuted(muted); this.renderGame(); }
      else if (id === 'story-mic' && view && view.phase !== 'lobby' && view.phase !== 'result') {
        this.storyTranscript = ''; this.storySentText = ''; this.storyCapture = true; this.pageIndex = 0; this.panel = 'story'; this.audio.startListening(); this.renderGame();
      } else if (id === 'story-stop') this.audio.stopListening();
      else if (id === 'story-send' && view && view.phase !== 'lobby' && view.phase !== 'result' && this.storyTranscript && !this.data.listening && !this.storySentText) {
        this.client.storyChat(this.storyTranscript); this.storySentText = this.storyTranscript; this.setData({ notice: '已提交给城主，正在等他回应' }); this.renderGame();
      }
      else if (id === 'create') this.createRoom();
      else if (id === 'chat-mic' && view && view.phase === 'lobby' && !this.startRequested) {
        this.lobbyTranscript = ''; this.lobbyQueue = []; this.captureLobbyEpoch = this.lobbyEpoch; this.captureLobbyRoom = this.roomId;
        this.lobbyAudio.startListening(); this.renderGame();
      } else if (id === 'chat-stop' && this.lobbyAudio) this.lobbyAudio.stopListening();
      else if (id === 'chat-send' && view && view.phase === 'lobby' && this.lobbyTranscript && !this.data.chatListening && !this.startRequested) {
        this.client.chat(this.lobbyTranscript); this.lobbySentText = this.lobbyTranscript; this.setData({ notice: '已提交聊天，正在等待服务确认' }); this.renderGame();
      }
      else if (id === 'reconnect') { this.stopLobbyChat(); this.audio.suspend(); this.client.disconnect(); this.connectRoom(); }
      else if (id === 'leave') this.leaveRoom();
      else if (id === 'next-page') { this.pageIndex = (this.pageIndex + 1) % this.pageTotal; this.renderGame(); }
      else if (['main', 'clues', 'players', 'history', 'chat', 'story'].includes(id)) { this.panel = id; this.pageIndex = 0; this.commandIndex = 0; this.renderGame(true); }
    } catch (_) { if (id === 'start') this.startRequested = false; this.setData({ notice: '操作未成功，请等待最新状态或重连' }); }
  },
  onKeyUp(event) {
    if (!this.foreground) return;
    const code = event.code;
    let action = null;
    if (this.data.screen === 'home') {
      if (code === 'Enter') action = () => [() => this.createRoom(), () => this.openDirectory(), () => this.openEditor(), () => this.enterLobby()][this.data.menuIndex]();
      if (code === 'ArrowLeft' || code === 'ArrowUp') action = () => this.setData({ menuIndex: (this.data.menuIndex + 3) % 4 });
      if (code === 'ArrowRight' || code === 'ArrowDown') action = () => this.setData({ menuIndex: (this.data.menuIndex + 1) % 4 });
    } else if (this.data.screen === 'rooms') {
      if (code === 'Enter') action = () => this.joinSelectedRoom();
      if (code === 'ArrowUp') action = () => this.previousRoom();
      if (code === 'ArrowDown') action = () => this.nextRoom();
      if (code === 'ArrowRight') action = () => this.refreshDirectory();
      if (code === 'ArrowLeft' || code === 'Backspace' || code === 'Escape') action = () => this.closeDirectory();
    } else if (this.data.screen === 'edit') {
      if (code === 'Enter') action = () => this.confirmDigit();
      if (code === 'ArrowLeft' || code === 'ArrowDown') action = () => this.decrementDigit();
      if (code === 'ArrowRight' || code === 'ArrowUp') action = () => this.incrementDigit();
      if (code === 'Backspace') action = () => this.previousDigit();
      if (code === 'Escape') action = () => this.cancelInput();
    } else if (this.data.screen === 'game') {
      if (code === 'Enter') action = () => this.activateAction();
      if (code === 'ArrowLeft') action = () => this.previousContent();
      if (code === 'ArrowRight') action = () => this.nextContent();
      if (code === 'ArrowUp') action = () => this.previousAction();
      if (code === 'ArrowDown') action = () => this.nextAction();
      if (code === 'Backspace' || code === 'Escape') action = () => {
        if (this.panel !== 'main') { this.panel = 'main'; this.pageIndex = 0; this.renderGame(true); }
        else this.leaveRoom();
      };
    }
    if (action) { if (event.preventDefault) event.preventDefault(); action(); }
  }
};
</script>

<page>
  <view class="app">
    <view ink:if="{{screen === 'home'}}" class="home">
      <view class="heading"><text class="title">月下同桌</text><text class="meta">狼人杀 · {{version}}</text></view>
      <text class="intro">真人与 AI，一起认真说一局</text>
      <view class="home-copy"><text>等朋友时与小月聊聊，任意一人都能开局</text></view>
      <button class="home-button {{menuIndex === 0 ? 'selected' : ''}}" bindtap="createRoom">创建房间</button>
      <button class="home-button {{menuIndex === 1 ? 'selected' : ''}}" bindtap="openDirectory">等待大厅 · 找房加入</button>
      <button class="home-button {{menuIndex === 2 ? 'selected' : ''}}" bindtap="openEditor">输入已有的 4 位房号</button>
      <button class="home-button {{menuIndex === 3 ? 'selected' : ''}}" bindtap="enterLobby">进入公共测试房</button>
      <text class="hint">{{homeHint}}</text>
      <text class="meta">上下选择 · 镜腿确认</text>
    </view>
    <view ink:elif="{{screen === 'rooms'}}" class="directory">
      <view class="heading"><text class="title">等待大厅</text><text class="meta">{{roomCount}} 个房间</text></view>
      <text class="directory-hint">选择仍在等待、尚有空位的房间</text>
      <view class="directory-list">
        <view ink:for="{{roomRows}}" ink:key="id" class="directory-room {{item.selected ? 'selected' : ''}}"><text class="directory-title">{{item.title}}</text><text class="meta">{{item.detail}}</text></view>
        <text ink:if="{{roomCount === 0}}" class="directory-empty">暂无房间，创建一间邀请朋友吧</text>
      </view>
      <view class="row"><button class="small" bindtap="previousRoom">上一</button><button class="main-button" bindtap="joinSelectedRoom" disabled="{{!roomCanJoin}}">{{roomJoinLabel}}</button><button class="small" bindtap="nextRoom">下一</button></view>
      <view class="row"><button class="minor" bindtap="refreshDirectory">刷新列表</button><button class="minor" bindtap="createRoom">创建房间</button><button class="minor" bindtap="closeDirectory">返回首页</button></view>
      <text class="hint">{{directoryNotice}}</text><text class="meta">{{roomPage}} · 上下选房 · 镜腿加入</text>
    </view>
    <view ink:elif="{{screen === 'edit'}}" class="editor">
      <view class="heading"><text class="title">{{inputTitle}}</text><text class="meta">{{inputStep}}</text></view>
      <view class="digits"><view ink:for="{{cells}}" ink:key="index" class="digit {{item.active ? 'selected' : ''}}"><text>{{item.text}}</text></view></view>
      <text class="hint">{{poseHint}}</text>
      <view class="row"><button class="small" bindtap="decrementDigit">减一</button><button class="main-button" bindtap="confirmDigit">{{confirmLabel}}</button><button class="small" bindtap="incrementDigit">加一</button></view>
      <view class="row"><button class="minor" bindtap="previousDigit">上一位</button><button class="minor" bindtap="calibratePose">重新校准</button><button class="minor" bindtap="reverseDirection">{{directionLabel}}</button></view>
      <text class="meta">回正后再摆一次 · 镜腿确认数字 · 返回键退一位</text>
    </view>
    <view ink:else class="game">
      <view class="game-heading"><text class="room-title">{{title}}</text><text class="round">{{roundLabel}}</text><text class="clock {{clockUrgent ? 'clock-urgent' : ''}}">{{timeLabel}}</text></view>
      <view class="stage-steps"><view ink:for="{{stageSteps}}" ink:key="id" class="stage-step {{item.active ? 'step-active' : item.past ? 'step-past' : ''}}"><text>{{item.name}}</text></view></view>
      <view class="stage-hero stage-{{stageMode}} {{stageFlash ? 'stage-flash' : ''}}">
        <view class="stage-heading" style="transform: translateY({{stageOffset}}px)"><text class="stage-name">{{stageName}}</text><text class="stage-badge">{{stageBadge}}</text></view>
        <text class="stage-hint">{{stageHint}}</text>
        <view class="stage-trace" style="width: {{stageTrace}}%"></view>
      </view>
      <view class="identity"><text>{{roleLine}}</text><text class="meta">{{aliveLabel}}</text></view>
      <view class="content">
        <view class="content-heading"><text>{{contentTitle}}</text><text class="meta" ink:if="{{showPaging}}">{{pageLabel}}</text></view>
        <text class="body">{{contentText}}</text>
      </view>
      <view class="selector"><button class="arrow" bindtap="previousContent">左</button><text class="choice">{{hasChoices ? choiceLabel : showPaging ? '左右翻阅完整文字' : '上下切换可用操作'}}</text><button class="arrow" bindtap="nextContent">右</button></view>
      <view class="action-row"><button class="arrow" bindtap="previousAction">上</button><button class="action selected {{ownTurn ? 'action-your-turn' : ''}}" bindtap="activateAction" disabled="{{!canAct}}">{{actionLabel}}</button><button class="arrow" bindtap="nextAction">下</button><text class="counter">{{actionCount}}</text></view>
      <text class="notice">{{notice}}</text>
      <text class="footer">左右选目标或翻页 · 上下选操作 · 镜腿确认</text>
    </view>
  </view>
</page>

<style>
.app { width: 480px; height: 352px; box-sizing: border-box; padding: 12px 16px; background-color: var(--color-background); color: var(--color-text-primary); font-family: sans-serif; }
.heading { height: 28px; display: flex; flex-direction: row; align-items: center; justify-content: space-between; }
.title { font-size: 22px; font-weight: 500; }
.meta { font-size: 11px; color: var(--color-text-secondary); }
.intro { display: block; font-size: 16px; margin: 8px 0 0; }
.home-copy { display: flex; flex-direction: column; font-size: 14px; margin: 8px 0; }
button { box-sizing: border-box; padding: 4px 8px; min-height: 32px; background-color: var(--color-background); color: var(--color-text-primary); border: 1px solid var(--border-color-default); border-radius: 4px; font-size: 14px; font-weight: 500; line-height: 22px; }
.home-button { display: block; width: 448px; height: 36px; margin: 6px 0 0; font-size: 16px; }
.directory-hint { display: block; font-size: 14px; height: 24px; line-height: 24px; }
.directory-list { height: 126px; }
.directory-room { box-sizing: border-box; height: 40px; margin: 2px 0; padding: 3px 8px; border: 1px solid var(--border-color-muted); border-radius: 4px; display: flex; flex-direction: row; align-items: center; justify-content: space-between; }
.directory-title { font-size: 16px; }
.directory-empty { font-size: 16px; line-height: 44px; }
.selected { border: 2px solid var(--color-primary); background-color: rgba(64,255,94,0.12); color: var(--color-primary); }
.hint { display: block; font-size: 14px; margin-top: 12px; margin-bottom: 8px; }
.digits { height: 100px; display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 12px; }
.digit { width: 68px; height: 72px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border-color-default); border-radius: 4px; font-size: 40px; }
.digit.selected { border: 2px solid var(--color-primary); }
.row { display: flex; flex-direction: row; gap: 8px; height: 44px; margin-top: 8px; }
.small { width: 72px; }.main-button { flex: 1; }.minor { flex: 1; font-size: 13px; }
.game-heading { height: 24px; display: flex; flex-direction: row; align-items: center; gap: 8px; }
.room-title { font-size: 16px; font-weight: 500; flex-grow: 1; }
.round { font-size: 12px; color: var(--color-text-secondary); }
.clock { font-size: 12px; color: var(--color-text-primary); }
.clock-urgent { color: var(--color-primary); border: 1px dashed var(--color-primary); border-radius: 4px; padding: 0 4px; }
.stage-steps { height: 22px; display: flex; flex-direction: row; align-items: center; gap: 4px; }
.stage-step { height: 17px; flex-grow: 1; flex-basis: 0; text-align: center; font-size: 11px; color: var(--color-text-secondary); border: 1px solid var(--border-color-muted); border-radius: 4px; }
.step-past { color: var(--color-text-primary); border-style: dashed; }
.step-active { color: var(--color-primary); border-color: var(--color-primary); background-color: rgba(64,255,94,0.12); }
.stage-hero { height: 56px; box-sizing: border-box; padding: 3px 8px; border: 1px solid var(--border-color-muted); border-radius: 6px; background-color: var(--color-background); transition-property: border-color, background-color; transition-duration: 280ms; transition-timing-function: ease-out; }
.stage-heading { height: 26px; display: flex; flex-direction: row; align-items: center; justify-content: space-between; transition-property: transform; transition-duration: 260ms; transition-timing-function: ease-out; }
.stage-name { font-size: 22px; font-weight: 500; color: var(--color-text-primary); }
.stage-badge { font-size: 12px; color: var(--color-primary); padding: 1px 6px; border: 1px solid var(--border-color-default); border-radius: 4px; }
.stage-hint { display: block; height: 18px; font-size: 12px; line-height: 18px; }
.stage-trace { height: 1px; background-color: var(--color-primary); transition-property: width; transition-duration: 600ms; transition-timing-function: ease-out; }
.stage-action { border-color: var(--color-primary); background-color: rgba(64,255,94,0.06); }
.stage-spectating { border-style: dashed; }
.stage-offline { border-style: dashed; }
.stage-flash { border-color: var(--color-primary); background-color: rgba(64,255,94,0.12); }
.identity { height: 24px; display: flex; flex-direction: row; align-items: center; justify-content: space-between; font-size: 12px; }
.content { height: 90px; box-sizing: border-box; padding: 2px 0; border: 1px solid var(--border-color-muted); border-radius: 6px; }
.content-heading { height: 20px; padding: 0 6px; display: flex; flex-direction: row; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 500; }
.body { display: block; padding: 0 6px; font-size: 16px; line-height: 21px; }
.selector { height: 34px; display: flex; flex-direction: row; gap: 8px; align-items: center; }
.arrow { width: 36px; padding: 2px; min-height: 30px; font-size: 12px; }
.choice { flex-grow: 1; flex-basis: 0; font-size: 14px; text-align: center; }
.action-row { height: 38px; display: flex; flex-direction: row; gap: 6px; align-items: center; }
.action { flex-grow: 1; flex-basis: 0; height: 34px; font-size: 15px; }
.action-your-turn { color: var(--color-primary); }
.counter { width: 28px; font-size: 10px; color: var(--color-text-secondary); }
.notice { display: block; height: 18px; font-size: 12px; line-height: 18px; }
.footer { display: block; height: 16px; font-size: 11px; color: var(--color-text-secondary); line-height: 16px; }
</style>
