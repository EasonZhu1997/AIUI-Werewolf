export function browserSocket(url) {
  const socket = new WebSocket(url);
  return {
    onOpen: fn => socket.addEventListener('open', fn),
    onMessage: fn => socket.addEventListener('message', fn),
    onClose: fn => socket.addEventListener('close', fn),
    onError: fn => socket.addEventListener('error', fn),
    send: data => socket.send(data), close: () => socket.close(),
  };
}

export class GameClient {
  constructor({ url, socketFactory = browserSocket, onState = () => {}, onStatus = () => {}, onWelcome = () => {}, onRooms = () => {} }) {
    this.url = url; this.socketFactory = socketFactory;
    this.onState = onState; this.onStatus = onStatus; this.onWelcome = onWelcome; this.onRooms = onRooms;
    this.rooms = []; this.mode = null;
    this.state = null; this.welcome = null; this.socket = null; this.generation = 0;
  }
  join(options) {
    if (!/^(?:\d{4}|lobby)$/.test(options.roomId || '')) throw new Error('请输入四位房间号');
    this.connect({ type: 'join', roomId: options.roomId, name: options.name, resumeToken: options.resumeToken, createIfMissing: options.createIfMissing }, '正在连接房间');
  }
  create({ name } = {}) { this.connect({ type: 'create', name }, '正在创建房间'); }
  browse() { this.connect({ type: 'rooms' }, '正在连接等待大厅'); }
  refreshRooms() { if (this.mode !== 'rooms') throw new Error('请先打开等待大厅'); this.send({ type: 'rooms' }); }
  chat(text) { this.send({ type: 'lobby_chat', text }); }
  connect(initial, status) {
    this.disconnect();
    if (!this.url) throw new Error('尚未配置游戏服务地址');
    const generation = ++this.generation;
    this.mode = initial.type;
    this.state = null; this.welcome = null; this.lastError = null; this.rooms = []; this.onStatus(status);
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    const current = () => this.generation === generation && this.socket === socket;
    socket.onOpen(() => {
      if (!current()) return;
      socket.send(JSON.stringify(initial));
      this.heartbeat = setInterval(() => { try { this.send({ type: 'ping' }); } catch (_) {} }, 20000);
    });
    socket.onMessage(event => {
      if (!current()) return;
      let message; try { message = JSON.parse(typeof event === 'string' ? event : event.data); } catch (_) { return; }
      if (message.type === 'welcome') { this.welcome = message; this.onWelcome(message); this.onStatus('已连接'); }
      if (message.type === 'state') { this.state = message.state; this.onState(this.state); }
      if (message.type === 'rooms' && this.mode === 'rooms' && Array.isArray(message.rooms)) {
        this.rooms = message.rooms; this.onRooms(this.rooms); this.onStatus('等待大厅已更新');
      }
      if (message.type === 'error') { this.lastError = message; this.onStatus(message.message || '操作失败'); }
    });
    socket.onClose(() => { if (current()) { this.clearHeartbeat(); this.socket = null; this.onStatus('连接已断开，请重新加入'); } });
    socket.onError(() => { if (current()) this.onStatus('连接失败，请检查服务和网络'); });
  }
  send(message) { if (!this.socket) throw new Error('请先连接房间'); this.socket.send(JSON.stringify(message)); }
  sendAction(action) { this.send({ type: 'action', action, revision: this.state?.revision }); }
  start() { this.send({ type: 'start' }); }
  restart() { this.send({ type: 'restart' }); }
  speechDone(speechId) { if (this.socket) this.send({ type: 'speech_done', speechId }); }
  leave() { try { if (this.socket) this.send({ type: 'leave' }); } finally { this.disconnect(); this.state = null; } }
  clearHeartbeat() {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  disconnect() {
    this.generation++; this.clearHeartbeat();
    const socket = this.socket; this.socket = null;
    try { socket?.close(); } catch (_) {}
  }
}
