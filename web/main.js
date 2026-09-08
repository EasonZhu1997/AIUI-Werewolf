import { GameClient, browserSocket } from '../lib/client.js';
import config from '../lib/config.js';
import { SpeechPlayback, VoiceInput } from './speech.js';
import { PhaseUI } from './phase-ui.js';
import { LobbyChatController, roomDirectoryEntries } from './lobby.js';

const $ = (id) => document.getElementById(id);
const dom = Object.fromEntries(['joinView', 'gameView', 'joinForm', 'nameInput', 'roomInput', 'joinButton', 'lobbyButton', 'connection', 'connectionText', 'soundButton', 'roomLabel', 'roomBadge', 'roundLabel', 'copyRoomButton', 'reconnectButton', 'leaveButton', 'phaseLabel', 'deadline', 'seats', 'tableMessage', 'aiStatus', 'speechPanel', 'speakerName', 'speechText', 'actionTitle', 'actionTag', 'actionDescription', 'choiceList', 'speechComposer', 'speechInput', 'recordButton', 'characterCount', 'sendSpeechButton', 'recognitionStatus', 'startButton', 'restartButton', 'roleSymbol', 'roleTitle', 'roleDescription', 'clueList', 'resultPanel', 'resultTitle', 'resultReason', 'logList', 'notice', 'voiceStatus'].map((id) => [id, $(id)]));
const lobbyDom = Object.fromEntries(['createRoomButton', 'refreshRoomsButton', 'directoryStatus', 'roomDirectoryList', 'lobbyChatPanel', 'lobbyStartButton', 'lobbyMessages', 'lobbyChatStatus', 'lobbyRetryButton', 'lobbyChatInput', 'lobbyRecordButton', 'lobbyCharCount', 'lobbySendButton', 'lobbyRecognitionStatus', 'lobbyVoiceStatus'].map(id => [id, $(id)]));
const store = {
  read(key) { try { return JSON.parse(localStorage.getItem(`werewolf:${key}`)); } catch { return null; } },
  write(key, value) { try { localStorage.setItem(`werewolf:${key}`, JSON.stringify(value)); } catch { /* Private browsing still permits a single session. */ } },
  remove(key) { try { localStorage.removeItem(`werewolf:${key}`); } catch { /* Optional persistence. */ } },
};
const phaseCopy = {
  lobby: ['等候开局', '每位在线玩家都可以现在开局，AI 会坐满余下的席位。'],
  night: ['天黑请闭眼', '请等待你的夜间行动。只有你能看见自己的身份与线索。'],
  speech: ['白天，轮流发言', '先听听其他人的想法。轮到你时，可以语音转文字或直接输入。'],
  playback: ['听听这位玩家怎么说', '发言会朗读给所有人；请结合公开信息进行推理。'],
  vote: ['投出你的一票', '每人一票，票数最高者出局；平票则无人出局。'],
  result: ['这一局，故事落幕', '身份已经揭晓。任一在线玩家都可以发起下一局。'],
};
const roleDetails = {
  wolf: ['狼人', '夜晚与狼队友选择目标，白天隐藏身份。', 'W'],
  werewolf: ['狼人', '夜晚与狼队友选择目标，白天隐藏身份。', 'W'],
  seer: ['预言家', '每晚查验一位玩家，用线索寻找狼人。', 'S'],
  witch: ['女巫', '拥有一瓶解药和一瓶毒药，每晚最多用一瓶。', 'A'],
  villager: ['村民', '没有夜间技能，你的观察与投票同样重要。', 'V'],
};
let client = null;
let state = null;
let joinedRoom = '';
let connected = false;
let joining = false;
let pending = false;
let sessionGeneration = 0;
let previousPrompt = '';
let lastLogId = '';
let noticeTimer;
let lastSeenError = null;
let directoryClient = null;
let directoryGeneration = 0;
let directoryRooms = [];
let lastChatSignature = '';
const phaseUI = new PhaseUI({ root: document });

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  dom.notice.textContent = String(message);
  dom.notice.classList.toggle('error', error);
  dom.notice.hidden = false;
  noticeTimer = setTimeout(() => { dom.notice.hidden = true; }, error ? 8500 : 4500);
}

function connectionStatus(message, online = connected) {
  dom.connectionText.textContent = message;
  dom.connection.classList.toggle('online', online);
}

function safeSend(fn) {
  if (!connected) { notify('连接已断开，请点击重新连接', true); return false; }
  try { fn(); return true; } catch (error) { notify(error.message || '操作未发送，请重试', true); pending = false; return false; }
}

const playback = new SpeechPlayback({
  onDone: (id) => { if (connected) { try { client.speechDone(id); } catch { /* Reconnection gets the current phase. */ } } },
  onStatus: (message) => { dom.voiceStatus.textContent = message; },
});
const voice = new VoiceInput({
  onText: (text) => {
    if (!connected || state?.prompt?.kind !== 'speech') return;
    dom.speechInput.value = text;
    updateComposer();
  },
  onStatus: (message) => { dom.recognitionStatus.textContent = message; },
  onActive: (active) => {
    dom.recordButton.textContent = active ? '结束录音' : '语音输入';
    dom.recordButton.classList.toggle('recording', active);
    dom.recordButton.setAttribute('aria-pressed', String(active));
  },
});
const lobbyChat = new LobbyChatController({
  onDraft: text => { lobbyDom.lobbyChatInput.value = text; },
  onStatus: message => { lobbyDom.lobbyRecognitionStatus.textContent = message; },
  onVoiceStatus: message => { lobbyDom.lobbyVoiceStatus.textContent = `小月：${message}`; dom.voiceStatus.textContent = `等待区 · ${message}`; },
  onChange: () => renderLobby(),
  onActive: active => {
    lobbyDom.lobbyRecordButton.textContent = active ? '结束录音' : '语音输入';
    lobbyDom.lobbyRecordButton.classList.toggle('recording', active);
    lobbyDom.lobbyRecordButton.setAttribute('aria-pressed', String(active));
  },
});

// Local self-check has no GameClient reference and can never acknowledge a game turn.
const soundTestButton = $('soundTestButton');
const soundTestStatus = $('soundTestStatus');
let soundTestSequence = 0;
const soundTest = new SpeechPlayback({
  onDone: () => { soundTestButton.disabled = false; soundTestButton.textContent = '再次试听普通话'; },
  onStatus: (message) => { soundTestStatus.textContent = message; dom.voiceStatus.textContent = `声音试听：${message}`; },
});
soundTestButton.addEventListener('click', () => {
  if (connected || joining) return;
  soundTestButton.disabled = true;
  soundTestButton.textContent = '正在试听…';
  soundTestStatus.textContent = '正在请求播放，请留意设备声音。';
  soundTest.play({ id: `local-voice-test-${++soundTestSequence}`, name: '普通话试听', narration: true, text: '二号发言。我想先听三号的解释，再决定把票投给谁。请大家慢慢说，我会认真听。' });
});

if (store.read('name')) dom.nameInput.value = String(store.read('name')).slice(0, 16);
const initialRoom = new URLSearchParams(location.hash.replace(/^#/, '')).get('room') || new URLSearchParams(location.search).get('room') || store.read('lastRoom');
if (/^\d{4}$/.test(initialRoom || '')) dom.roomInput.value = initialRoom;
if (store.read('sound') === false) playback.setEnabled(false);
lobbyChat.setEnabled(playback.enabled);
updateSoundButton();
updateResumeLabel();

function updateSoundButton() {
  dom.soundButton.textContent = playback.enabled ? '声音已开启' : '声音已静音';
  dom.soundButton.setAttribute('aria-pressed', String(playback.enabled));
}

function updateResumeLabel() {
  const session = store.read(`room:${dom.roomInput.value}`);
  dom.joinButton.replaceChildren(document.createTextNode(session?.resumeToken ? '回到上次的座位' : '加入已有房间'), element('span', '', '↗'));
  const lobby = store.read('room:lobby');
  dom.lobbyButton.replaceChildren(document.createTextNode(lobby?.resumeToken ? '回到公共大厅的座位' : '去公共大厅试一局'), element('span', '', '→'));
}

function endpoint() {
  if (config.url) return config.url;
  const url = new URL('/werewolf/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function showJoin() {
  lobbyChat.reset();
  phaseUI.reset();
  state = null;
  previousPrompt = '';
  pending = false;
  joining = false;
  connected = false;
  dom.gameView.hidden = true;
  dom.joinView.hidden = false;
  dom.joinButton.disabled = false;
  dom.lobbyButton.disabled = false;
  lobbyDom.createRoomButton.disabled = false;
  dom.reconnectButton.hidden = true;
  connectionStatus('尚未入座', false);
  updateResumeLabel();
  startDirectory();
}

function joinRoom(roomId, { create = false } = {}) {
  const name = dom.nameInput.value.trim();
  if (!name) { dom.nameInput.reportValidity(); dom.nameInput.focus(); return; }
  if (!create && !/^(?:\d{4}|lobby)$/.test(roomId)) { notify('请输入四位数字房间号', true); dom.roomInput.focus(); return; }
  stopDirectory();
  lobbyChat.reset();
  voice.cancel();
  soundTest.cancel('试听已停止');
  playback.reset();
  playback.unlock();
  client?.disconnect();
  const generation = ++sessionGeneration;
  joinedRoom = create ? '' : roomId;
  connected = false;
  joining = true;
  pending = false;
  phaseUI.reset();
  lastSeenError = null;
  dom.joinButton.disabled = true;
  dom.lobbyButton.disabled = true;
  lobbyDom.createRoomButton.disabled = true;
  dom.reconnectButton.disabled = true;
  store.write('name', name);
  const resume = create ? null : store.read(`room:${roomId}`);
  const current = () => generation === sessionGeneration;
  client = new GameClient({
    url: endpoint(),
    socketFactory: browserSocket,
    onWelcome(message) {
      if (!current()) return;
      const actualRoom = message.roomId || (create ? '' : roomId);
      if (!/^(?:\d{4}|lobby)$/.test(actualRoom)) { client.disconnect(); showJoin(); notify('服务器未返回有效房号，请重新创建', true); return; }
      joinedRoom = actualRoom;
      connected = true;
      joining = false;
      dom.joinButton.disabled = false;
      dom.lobbyButton.disabled = false;
      lobbyDom.createRoomButton.disabled = false;
      dom.reconnectButton.hidden = true;
      dom.reconnectButton.disabled = false;
      store.write(`room:${actualRoom}`, { resumeToken: message.resumeToken, name });
      store.write('lastRoom', actualRoom);
      if (/^\d{4}$/.test(actualRoom)) dom.roomInput.value = actualRoom;
      updateResumeLabel();
    },
    onState(view) {
      if (!current()) return;
      state = view;
      connected = true;
      pending = false;
      joining = false;
      dom.joinView.hidden = true;
      dom.gameView.hidden = false;
      connectionStatus('已入座', true);
      render();
      if (!lobbyChat.startRequested) dom.reconnectButton.hidden = true;
    },
    onStatus(message) {
      if (!current()) return;
      connectionStatus(message);
      if (client.lastError && client.lastError !== lastSeenError) {
        lastSeenError = client.lastError;
        const startError = lobbyChat.handleServerError(client.lastError);
        phaseUI.clearSubmission();
        pending = false;
        joining = false;
        dom.joinButton.disabled = false;
        dom.lobbyButton.disabled = false;
        lobbyDom.createRoomButton.disabled = false;
        if (state?.phase === 'lobby' && lobbyChat.sending) lobbyChat.handleError(message);
        if (client.lastError.code === 'RESUME_EXPIRED') {
          store.remove(`room:${joinedRoom || roomId}`);
          client.disconnect();
          showJoin();
          notify('上次牌局已结束或服务已重启。旧座位已清除，点击进入房间重新入座。', true);
          return;
        }
        if (startError.needsSync) { dom.reconnectButton.hidden = false; dom.reconnectButton.disabled = false; }
        notify(startError.needsSync ? `${message}。开局进度待确认，可点击「重新连接」同步。` : message, true);
        if (!connected) startDirectory();
      }
      if (/断开|连接失败/.test(message)) {
        connected = false;
        joining = false;
        pending = false;
        voice.cancel();
        lobbyChat.suspend();
        playback.cancel('连接断开，朗读已停止');
        dom.joinButton.disabled = false;
        dom.lobbyButton.disabled = false;
        lobbyDom.createRoomButton.disabled = false;
        dom.reconnectButton.hidden = !state;
        dom.reconnectButton.disabled = false;
        connectionStatus('连接已断开', false);
        if (!state) startDirectory();
      }
      if (state) { renderActions(); renderLobby(); }
    },
  });
  try { if (create) client.create({ name }); else client.join({ roomId, name, createIfMissing: false, ...(resume?.resumeToken ? { resumeToken: resume.resumeToken } : {}) }); }
  catch (error) { joining = false; dom.joinButton.disabled = false; dom.lobbyButton.disabled = false; lobbyDom.createRoomButton.disabled = false; notify(error.message, true); connectionStatus('连接未建立', false); startDirectory(); }
}

function renderSeats() {
  const fragment = document.createDocumentFragment();
  for (let number = 1; number <= 6; number++) {
    const player = state.players.find((item) => item.seat === number);
    const card = element('div', `seat${player ? '' : ' empty'}${player?.bot ? ' bot' : ''}${player?.id === state.selfId ? ' self-seat' : ''}${player && !player.alive && state.phase !== 'lobby' ? ' dead' : ''}${state.speech?.seat === number ? ' speaking' : ''}`);
    const top = element('div', 'seat-top');
    top.append(element('span', '', String(number).padStart(2, '0')), element('span', '', player?.id === state.selfId ? '你' : player?.bot ? 'AI' : player ? '真人' : '空位'));
    card.append(top, element('div', 'seat-icon'), element('div', 'seat-name', player?.name || '等待入座'));
    let status = player ? (player.bot ? 'AI 伙伴' : player.connected ? '已入座' : '暂时离线') : '开局由 AI 补位';
    if (player && state.phase !== 'lobby' && !player.alive) status = '已出局';
    if (state.speech?.seat === number) status = '正在发言';
    if (player?.role && state.phase === 'result') status = roleDetails[player.role]?.[0] || player.role;
    card.append(element('div', 'seat-state', status));
    card.setAttribute('aria-label', `${number} 号，${player?.name || '空位'}，${status}${player?.id === state.selfId ? '，你的座位' : ''}`);
    fragment.append(card);
  }
  dom.seats.replaceChildren(fragment);
}

function renderRole() {
  const self = state.self;
  const detail = roleDetails[self?.role];
  dom.roleTitle.textContent = self?.roleName || detail?.[0] || '身份尚未揭晓';
  dom.roleDescription.textContent = self ? detail?.[1] || '请根据你的身份与公开信息参与推理。' : '开局后，你会拿到自己的身份牌。';
  dom.roleSymbol.textContent = detail?.[2] || '?';
  const clues = [...(self?.clues || [])];
  if (self?.potions) {
    const save = self.potions.save ?? self.potions.antidote;
    const poison = self.potions.poison;
    if (save !== undefined || poison !== undefined) clues.unshift(`解药${save ? '可用' : '已用'} · 毒药${poison ? '可用' : '已用'}`);
  }
  dom.clueList.replaceChildren(...clues.map((text) => element('li', '', text)));
}

function renderActions() {
  const prompt = state.prompt;
  const phase = phaseCopy[state.phase] || ['牌局进行中', '等待下一步。'];
  const self = state.players.find((player) => player.id === state.selfId);
  dom.actionTitle.textContent = prompt?.label || phase[0];
  dom.actionTag.textContent = prompt ? '轮到你了' : self && !self.alive && state.phase !== 'lobby' ? '旁观中' : state.canStart ? '随时开局' : '';
  dom.actionDescription.textContent = !connected ? '连接已断开，重新连接后可继续这局游戏。' : self && !self.alive && !['lobby', 'result'].includes(state.phase) ? '你已出局，可以继续听大家发言，等待身份揭晓。' : prompt?.kind === 'night' ? '这是你的私密行动。选择后立即提交，请看准目标。' : prompt?.kind === 'speech' ? '可以说出你的判断、回应质疑。最多 240 字，发送后会朗读给同桌玩家。' : phase[1];
  const promptKey = prompt?.kind === 'speech' ? `${state.round}:${state.selfSeat}:speech` : '';
  if (previousPrompt !== promptKey) {
    voice.cancel();
    dom.speechInput.value = '';
    dom.recognitionStatus.textContent = voice.supported ? '麦克风仅在你点击「语音输入」后开启。' : '此浏览器不支持语音转文字，请直接输入发言。';
    previousPrompt = promptKey;
  }
  dom.speechComposer.hidden = prompt?.kind !== 'speech';
  dom.choiceList.replaceChildren();
  if (prompt && prompt.kind !== 'speech') {
    for (const choice of prompt.choices || []) {
      const button = element('button', `choice-button${choice.action === 'skip' ? ' skip' : ''}`, choice.label);
      button.type = 'button';
      button.disabled = !connected || pending;
      button.addEventListener('click', () => {
        if (pending) return;
        pending = true;
        if (!safeSend(() => client.sendAction({ kind: prompt.kind, target: choice.target, action: choice.action }))) pending = false;
        else phaseUI.markSubmitted();
        renderActions();
      });
      dom.choiceList.append(button);
    }
  }
  dom.startButton.hidden = !state.canStart;
  dom.restartButton.hidden = !state.canRestart;
  dom.startButton.disabled = !connected || pending || lobbyChat.startRequested;
  dom.restartButton.disabled = !connected || pending;
  updateComposer();
  phaseUI.update(state, { connected, pending: pending || lobbyChat.startRequested });
}

function updateComposer() {
  dom.characterCount.textContent = `${dom.speechInput.value.length} / 240`;
  dom.speechInput.disabled = !connected || pending;
  dom.sendSpeechButton.disabled = !connected || pending || !dom.speechInput.value.trim();
  dom.recordButton.disabled = !connected || pending || !voice.supported;
}

function render() {
  dom.roomLabel.textContent = state.roomId === 'lobby' ? '公共大厅' : state.roomId;
  dom.roomBadge.textContent = `${state.players.length} / 6 人`;
  dom.roundLabel.textContent = state.phase === 'lobby' ? '今夜的同桌' : state.phase === 'result' ? '游戏结束' : `第 ${state.round} 轮`;
  dom.phaseLabel.textContent = state.phaseLabel || phaseCopy[state.phase]?.[0] || '牌局进行中';
  dom.tableMessage.textContent = state.phase === 'lobby' ? '一位真人即可开局，AI 伙伴会补齐六个座位。' : state.phase === 'night' ? '夜间行动只对本人可见，请保持你的秘密。' : state.phase === 'result' ? '感谢今夜同桌。还想再聊一局吗？' : state.speech ? `${state.speech.seat} 号 ${state.speech.name} 的回合` : '听发言，找线索，再决定相信谁。';
  dom.aiStatus.textContent = state.aiStatus || '';
  renderSeats();
  renderRole();
  lobbyChat.sync(state, { connected, hidden: document.hidden });
  renderActions();
  dom.speechPanel.hidden = !state.speech;
  if (state.speech) {
    dom.speakerName.textContent = `${state.speech.seat} 号 · ${state.speech.name}`;
    dom.speechText.textContent = state.speech.text;
    voice.cancel();
    playback.play(state.speech);
  } else if (playback.current) playback.cancel('');
  dom.resultPanel.hidden = !state.result;
  if (state.result) {
    dom.resultTitle.textContent = state.result.winner === 'wolves' ? '狼人阵营获胜' : state.result.winner === 'villagers' ? '好人阵营获胜' : '本局平局';
    dom.resultReason.textContent = state.result.reason;
  }
  const logs = state.logs || [];
  const newest = logs.at(-1)?.id || '';
  if (newest !== lastLogId || dom.logList.firstElementChild?.classList.contains('empty-log')) {
    lastLogId = newest;
    dom.logList.replaceChildren(...(logs.length ? logs.map((entry) => {
      const item = element('li', '', entry.text);
      if (entry.round) item.prepend(element('span', 'log-round', `第 ${entry.round} 轮`));
      return item;
    }) : [element('li', 'empty-log', '故事还没有开始。')]));
    dom.logList.scrollTop = dom.logList.scrollHeight;
  }
  updateDeadline();
}

function updateDeadline() {
  const show = connected && state?.deadline && (state.phase !== 'night' || state.prompt);
  dom.deadline.textContent = show ? `${Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000))} 秒` : '';
  phaseUI.tick();
}

function stopDirectory() {
  directoryGeneration++;
  directoryClient?.disconnect(); directoryClient = null;
}

function startDirectory() {
  if (document.hidden || dom.joinView.hidden || joining || directoryClient?.socket) return;
  stopDirectory();
  const generation = ++directoryGeneration;
  lobbyDom.directoryStatus.textContent = '正在连接等待大厅…';
  directoryClient = new GameClient({ url: endpoint(), socketFactory: browserSocket,
    onRooms(rooms) {
      if (generation !== directoryGeneration) return;
      directoryRooms = roomDirectoryEntries(rooms);
      renderDirectory();
      const available = directoryRooms.filter(room => room.canJoin).length;
      lobbyDom.directoryStatus.textContent = available ? `${available} 桌正在等同伴，选一个房间入座。` : '暂时没有可加入的桌子，创建一个房间邀请朋友吧。';
    },
    onStatus(message) {
      if (generation !== directoryGeneration) return;
      if (/失败|断开|错误/.test(message)) lobbyDom.directoryStatus.textContent = '房间列表连接中断，点击「刷新房间」重试。';
    },
  });
  try { directoryClient.browse(); }
  catch (error) { lobbyDom.directoryStatus.textContent = error.message || '暂时无法获取房间列表，请刷新重试。'; stopDirectory(); }
}

function renderDirectory() {
  lobbyDom.roomDirectoryList.replaceChildren(...(directoryRooms.length ? directoryRooms.map(room => {
    const card = element('div', `directory-room${room.canJoin ? ' available' : ''}`);
    const info = element('div', 'directory-room-info');
    info.append(element('strong', '', room.label), element('span', '', `${room.members} / ${room.capacity} 席 · ${room.online} 位真人在线`));
    const action = element('button', 'directory-join', room.canJoin ? '加入 →' : room.status);
    action.type = 'button'; action.disabled = !room.canJoin || joining;
    action.addEventListener('click', () => { if (!joining) joinRoom(room.roomId); });
    card.append(info, action); return card;
  }) : [element('p', 'directory-empty', '还没有房间。创建第一桌，小月会陪你等大家。')]));
}

function renderLobby() {
  const inLobby = state?.phase === 'lobby';
  lobbyDom.lobbyChatPanel.hidden = !inLobby;
  if (!inLobby) return;
  lobbyDom.lobbyStartButton.disabled = !connected || pending || lobbyChat.startRequested || !state.canStart;
  const signature = `${state.roomId}:${state.selfId}:` + JSON.stringify(lobbyChat.messages.map(message => [message.id, message.text]));
  if (signature !== lastChatSignature) {
    lastChatSignature = signature;
    lobbyDom.lobbyMessages.replaceChildren(...(lobbyChat.messages.length ? lobbyChat.messages.map(message => {
      const item = element('div', `lobby-message ${message.kind === 'agent' ? 'agent' : 'human'}`);
      item.append(element('span', 'lobby-message-name', message.kind === 'agent' ? `${message.name || '小月'} · AI 伙伴` : message.name), element('p', '', message.text));
      return item;
    }) : [element('p', 'lobby-empty', '朋友还在路上？问问小月规则，聊聊你的推理风格，或者打个招呼。')]));
    lobbyDom.lobbyMessages.scrollTop = lobbyDom.lobbyMessages.scrollHeight;
  }
  const error = lobbyChat.error || (lobbyChat.status === 'error' ? '小月暂时没有回应，可以重试。' : '');
  const status = !connected ? '连接已断开，请先重新连接。' : lobbyChat.startRequested ? '正在开局，等待区聊天已暂停。' : error || (lobbyChat.busy ? '小月正在思考…你仍可以随时开局。' : '小月在听。确认文字后发送，回复会自动朗读。');
  if (lobbyDom.lobbyChatStatus.textContent !== status) lobbyDom.lobbyChatStatus.textContent = status;
  lobbyDom.lobbyChatStatus.classList.toggle('chat-error', Boolean(error));
  lobbyDom.lobbyChatPanel.classList.toggle('chat-thinking', lobbyChat.busy);
  lobbyDom.lobbyRetryButton.hidden = !error || !lobbyChat.lastSent;
  lobbyDom.lobbyRetryButton.disabled = !lobbyChat.active || lobbyChat.busy;
  lobbyDom.lobbyChatInput.disabled = !lobbyChat.active;
  lobbyDom.lobbySendButton.disabled = !lobbyChat.active || lobbyChat.busy || !lobbyChat.draft.trim();
  lobbyDom.lobbyRecordButton.disabled = !lobbyChat.active || !lobbyChat.voice.supported;
  lobbyDom.lobbyCharCount.textContent = `${lobbyChat.draft.length} / 240`;
}

function startGame() {
  if (pending || lobbyChat.startRequested) return;
  pending = true;
  lobbyChat.prepareGame();
  lobbyDom.lobbyVoiceStatus.textContent = '准备开局，等待区语音已停止。';
  if (!safeSend(() => client.start())) { pending = false; lobbyChat.cancelGameStart(); lobbyChat.sync(state, { connected, hidden: document.hidden }); }
  renderActions(); renderLobby();
}

dom.joinForm.addEventListener('submit', (event) => { event.preventDefault(); if (!joining) joinRoom(dom.roomInput.value.trim()); });
lobbyDom.createRoomButton.addEventListener('click', () => { if (!joining) joinRoom('', { create: true }); });
lobbyDom.refreshRoomsButton.addEventListener('click', () => {
  if (directoryClient?.socket) { try { directoryClient.refreshRooms(); } catch { stopDirectory(); startDirectory(); } }
  else startDirectory();
});
dom.lobbyButton.addEventListener('click', () => { if (!joining) joinRoom('lobby'); });
dom.roomInput.addEventListener('input', () => { dom.roomInput.value = dom.roomInput.value.replace(/\D/g, '').slice(0, 4); updateResumeLabel(); });
dom.soundButton.addEventListener('click', () => { playback.setEnabled(!playback.enabled); lobbyChat.setEnabled(playback.enabled); store.write('sound', playback.enabled); updateSoundButton(); dom.voiceStatus.textContent = playback.enabled ? '声音已开启，下一次发言将自动朗读。' : '已静音，发言仍会完整显示为文字。'; });
dom.reconnectButton.addEventListener('click', () => { if (joinedRoom && !joining) joinRoom(joinedRoom); });
dom.leaveButton.addEventListener('click', () => {
  voice.cancel(); playback.cancel('');
  if (!state || ['lobby', 'result'].includes(state.phase)) store.remove(`room:${joinedRoom}`);
  sessionGeneration++;
  try { client?.leave(); } catch { client?.disconnect(); }
  showJoin();
  dom.voiceStatus.textContent = '已离开房间，朗读已停止。可在首页试听声音。';
});
dom.startButton.addEventListener('click', startGame);
lobbyDom.lobbyStartButton.addEventListener('click', startGame);
lobbyDom.lobbyChatInput.addEventListener('input', () => lobbyChat.setDraft(lobbyDom.lobbyChatInput.value));
lobbyDom.lobbyRecordButton.addEventListener('click', () => { if (state?.phase !== 'lobby' || !connected) return; if (lobbyChat.voice.active) lobbyChat.stopVoice(); else lobbyChat.startVoice(); });
lobbyDom.lobbySendButton.addEventListener('click', () => { if (state?.phase === 'lobby') lobbyChat.submit(text => client.chat(text)); });
lobbyDom.lobbyRetryButton.addEventListener('click', () => { if (state?.phase === 'lobby') lobbyChat.retry(text => client.chat(text)); });
dom.restartButton.addEventListener('click', () => { if (pending) return; pending = true; if (!safeSend(() => client.restart())) pending = false; renderActions(); });
dom.speechInput.addEventListener('input', updateComposer);
dom.recordButton.addEventListener('click', () => {
  if (!connected || state?.prompt?.kind !== 'speech' || pending) return;
  if (voice.active) voice.stop(); else { playback.cancel(''); voice.start(); }
});
dom.sendSpeechButton.addEventListener('click', () => {
  const text = dom.speechInput.value.trim();
  if (pending || !text || state?.prompt?.kind !== 'speech') return;
  voice.cancel();
  pending = true;
  if (!safeSend(() => client.sendAction({ kind: 'speech', text }))) pending = false;
  else phaseUI.markSubmitted();
  updateComposer();
  phaseUI.update(state, { connected, pending });
});
dom.copyRoomButton.addEventListener('click', async () => {
  const url = new URL(location.href);
  url.search = '';
  url.hash = `room=${joinedRoom}`;
  try {
    await navigator.clipboard.writeText(url.href);
    notify(location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '已复制。本机地址仅供这台电脑使用；跨设备请打开同一服务器的公网地址。' : '邀请链接已复制，发给朋友即可同桌。');
  } catch { notify(`当前${joinedRoom === 'lobby' ? '公共大厅' : `房间号：${joinedRoom}`}。朋友在同一网站输入房间号即可加入。`); }
});
document.addEventListener('visibilitychange', () => {
  voice.cancel(); playback.setHidden(document.hidden); soundTest.setHidden(document.hidden); phaseUI.setHidden(document.hidden); lobbyChat.setHidden(document.hidden);
  if (document.hidden) stopDirectory();
  else if (!dom.joinView.hidden) startDirectory();
  else if (state) lobbyChat.sync(state, { connected, hidden: false });
  renderLobby();
});
window.addEventListener('pagehide', () => { voice.cancel(); lobbyChat.suspend(); stopDirectory(); playback.cancel(''); soundTest.cancel('试听已停止'); client?.disconnect(); connected = false; phaseUI.setHidden(true); });
window.addEventListener('pageshow', (event) => { if (event.persisted && state) { phaseUI.setHidden(false); dom.reconnectButton.hidden = false; dom.reconnectButton.disabled = false; renderActions(); renderLobby(); connectionStatus('连接已断开', false); } else if (!dom.joinView.hidden) startDirectory(); });
setInterval(updateDeadline, 500);
startDirectory();
