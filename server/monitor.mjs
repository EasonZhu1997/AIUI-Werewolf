// A deliberate operational projection, never a serialized Game or provider.
const PHASES = { lobby: '等待入座', night: '夜晚行动', speech: '依次发言', playback: '正在朗读', vote: '放逐投票', result: '本局结束' };
const roomIdOf = value => /^(?:\d{4}|lobby)$/.test(value || '') ? value : undefined;
const safeNumber = value => Number.isFinite(value) && value >= 0 ? value : null;

export class ServiceMonitor {
  constructor({ now = Date.now, eventLimit = 100 } = {}) {
    this.now = now; this.startedAt = now(); this.events = []; this.sequence = 0;
    this.eventLimit = eventLimit; this.roomStates = new Map();
    this.event('service_started', '服务已启动');
  }
  event(kind, message, { roomId, level = 'info' } = {}) {
    const item = { id: ++this.sequence, at: this.now(), level, kind, message };
    const id = roomIdOf(roomId); if (id) item.roomId = id;
    this.events.unshift(item); this.events.length = Math.min(this.events.length, this.eventLimit);
  }
  observe(room) {
    const game = room.game; const id = game.roomId;
    const next = { phase: game.phase, round: game.round, online: room.sockets.size,
      seats: game.players.filter(p => !p.bot).length, paused: !room.sockets.size,
      aiError: Boolean(room.failedKey && room.aiStatus), chatError: room.lobbyChat.status === 'error' };
    const previous = this.roomStates.get(id);
    if (!previous) this.event('room_created', '已创建房间', { roomId: id });
    if (previous && (previous.phase !== next.phase || previous.round !== next.round)) {
      this.event('phase_changed', `第 ${next.round} 轮 · ${PHASES[next.phase] || '状态已更新'}`, { roomId: id });
    }
    if (!previous || previous.online !== next.online || previous.seats !== next.seats) {
      this.event('attendance_changed', `${next.seats} 位真人入座 · ${next.online} 位在线`, { roomId: id });
    }
    if (previous && previous.paused !== next.paused) this.event(next.paused ? 'room_paused' : 'room_resumed', next.paused ? '所有真人离线，已暂停推进' : '真人重新在线，已恢复推进', { roomId: id });
    if (next.aiError && !previous?.aiError) this.event('game_ai_failed', 'AI 行动暂未完成，将按牌局时限处理', { roomId: id, level: 'error' });
    if (next.chatError && !previous?.chatError) this.event('companion_failed', '等待区 AI 回复失败或超时', { roomId: id, level: 'error' });
    this.roomStates.set(id, next);
  }
  removed(id, reason) {
    this.roomStates.delete(id);
    this.event('room_removed', reason === 'expired' ? '离线房间已到期回收' : '等待房间已清空回收', { roomId: id });
  }
  snapshot({ rooms, connections = [], provider, maxRooms, maxConnections }) {
    const time = this.now();
    const rows = [...rooms.values()].map(room => {
      const game = room.game;
      const players = game.players.map(player => ({ seat: player.seat,
        name: typeof player.name === 'string' ? Array.from(player.name).slice(0, 24).join('') : '玩家',
        bot: Boolean(player.bot), connected: Boolean(player.connected), alive: Boolean(player.alive) }));
      const liveIds = [...room.sockets.keys()];
      return { roomId: game.roomId, phase: game.phase, round: game.round, revision: game.revision,
        createdAt: room.createdAt, lastActiveAt: room.lastActive, paused: !room.sockets.size,
        // Night substage timing can reveal which private role is currently acting.
        deadline: game.phase === 'night' || !room.sockets.size ? null : game.deadline,
        humans: players.filter(p => !p.bot).length, onlineHumans: room.sockets.size,
        bots: players.filter(p => p.bot).length, capacity: 6,
        aiState: room.failedKey && room.aiStatus ? 'error' : room.busy ? 'thinking' : 'idle',
        chatState: ['idle', 'thinking', 'error'].includes(room.lobbyChat.status) ? room.lobbyChat.status : 'idle',
        players,
        playback: game.phase === 'playback' ? { pendingAcks: liveIds.filter(id => !room.acks.has(id)).length, totalHumans: liveIds.length } : null };
    }).sort((a, b) => a.roomId === 'lobby' ? -1 : b.roomId === 'lobby' ? 1 : a.roomId.localeCompare(b.roomId));
    const raw = typeof provider?.getMetrics === 'function' ? provider.getMetrics(time) : {};
    const ai = { configured: Boolean(provider), model: typeof raw.model === 'string' ? raw.model.slice(0, 80) : null };
    for (const key of ['callsLastHour', 'maxCallsPerHour', 'successes', 'failures', 'cancellations', 'inFlight', 'averageLatencyMs', 'lastSuccessAt', 'lastFailureAt']) ai[key] = safeNumber(raw[key]);
    const sockets = [...connections];
    return { version: '0.1.4', adminVersion: '0.1.0', startedAt: this.startedAt, now: time,
      uptimeMs: Math.max(0, time - this.startedAt),
      summary: { rooms: rows.length, waitingRooms: rows.filter(r => r.phase === 'lobby').length,
        activeRooms: rows.filter(r => !['lobby', 'result'].includes(r.phase)).length,
        pausedRooms: rows.filter(r => r.paused).length,
        onlineHumans: rows.reduce((n, r) => n + r.onlineHumans, 0), botSeats: rows.reduce((n, r) => n + r.bots, 0),
        connections: sockets.length, directoryConnections: sockets.filter(ws => ws.wantsRooms && !ws.room).length },
      limits: { maxRooms, maxConnections, maxPlayers: 6 }, ai, rooms: rows,
      events: this.events.map(event => ({ ...event })) };
  }
}
