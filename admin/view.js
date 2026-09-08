const PHASES = { lobby: '等待开局', night: '夜晚行动', speech: '白天发言', playback: '语音播放', vote: '投票放逐', result: '本局结算' };
const STATES = { idle: '空闲', thinking: '回复中', error: '请求异常' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
export const phaseLabel = room => room?.paused ? '已暂停' : (PHASES[room?.phase] || '状态未知');
export const roomLabel = roomId => roomId === 'lobby' ? '公共大厅' : String(roomId ?? '');
export function timeLabel(value, full = false) {
  if (value === null || value === undefined || value === '') return '暂无';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '暂无';
  return new Intl.DateTimeFormat('zh-CN', { ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}
export function durationLabel(ms) {
  const seconds = Math.floor(count(ms) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
  return `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`;
}
export function filteredRooms(rooms, query = '', filter = 'all') {
  const search = String(query).trim().toLowerCase();
  return (Array.isArray(rooms) ? rooms : []).filter(room => {
    if (!`${room.roomId} ${roomLabel(room.roomId)}`.toLowerCase().includes(search)) return false;
    if (filter === 'all') return true;
    if (filter === 'paused') return !!room.paused;
    if (filter === 'active') return !['lobby', 'result'].includes(room.phase);
    return room.phase === filter;
  }).sort((a, b) => Number(!!b.paused) - Number(!!a.paused) || count(b.onlineHumans) - count(a.onlineHumans) || String(a.roomId).localeCompare(String(b.roomId)));
}
export function summaryHtml(snapshot) {
  const s = snapshot.summary || {}, limits = snapshot.limits || {};
  const cards = [
    ['在线真人', 'PLAYERS', count(s.onlineHumans), '', `${count(s.botSeats)} 位 AI 在席`],
    ['当前房间', 'ROOMS', count(s.rooms), '', `${count(s.waitingRooms)} 桌等待 · ${count(s.activeRooms)} 桌游戏中`],
    ['已暂停房间', 'PAUSED', count(s.pausedRooms), '', '断线后等待玩家回归'],
    ['实时连接', 'SOCKETS', count(s.connections), ` / ${count(limits.maxConnections)}`, `${count(s.directoryConnections)} 个大厅浏览连接`]
  ];
  return cards.map(([label, tag, value, unit, foot]) => `<article class="stat-card"><p class="stat-label">${label}<span>${tag}</span></p><p class="stat-number">${value}<small>${unit}</small></p><p class="stat-foot">${foot}</p></article>`).join('');
}
function roomTone(room) { return room.paused ? 'paused' : (['night', 'vote', 'result'].includes(room.phase) ? room.phase : ''); }
export function roomsHtml(rooms, selectedId = '', filtered = false) {
  if (!rooms.length) return `<div class="empty"><span class="empty-moon" aria-hidden="true"></span><p>${filtered ? '没有符合条件的房间' : '还没有玩家入座'}</p><small>${filtered ? '试试其他房间号或阶段。' : '房间创建后会出现在这里，状态自动更新。'}</small></div>`;
  return rooms.map(room => {
    const online = count(room.onlineHumans), humans = count(room.humans), bots = count(room.bots);
    const dots = Array.from({ length: Math.min(6, count(room.capacity) || 6) }, (_, index) => `<i class="seat-dot ${index < online ? 'human' : index < humans ? 'offline' : index < humans + bots ? 'bot' : ''}"></i>`).join('');
    const activity = room.paused ? '等待重新连接' : room.aiState === 'thinking' ? '牌局 AI 正在思考' : room.chatState === 'thinking' ? '小月正在回复' : room.aiState === 'error' || room.chatState === 'error' ? 'AI 请求异常 · 查看详情' : '查看房间详情 ↗';
    return `<button class="room-row" type="button" data-room="${escapeHtml(room.roomId)}" aria-pressed="${room.roomId === selectedId}" aria-label="查看${escapeHtml(roomLabel(room.roomId))}，${phaseLabel(room)}"><div class="room-top"><span class="room-title">${escapeHtml(roomLabel(room.roomId))}<small>${room.phase === 'lobby' ? '等待区' : `第 ${count(room.round)} 轮`}</small></span><span class="pill ${roomTone(room)}">${phaseLabel(room)}</span></div><div class="room-bottom"><span><span class="seat-dots" aria-hidden="true">${dots}</span>${online} 真人在线 · ${bots} AI</span><span>${activity}</span></div></button>`;
  }).join('');
}
export function roomDetailHtml(room) {
  if (!room) return '';
  const fields = [
    ['当前阶段', phaseLabel(room)], ['阶段到期', room.paused ? '已暂停' : room.phase === 'night' ? '夜间行动中' : room.deadline ? timeLabel(room.deadline) : '无需计时'],
    ['创建时间', timeLabel(room.createdAt, true)], ['最近活动', timeLabel(room.lastActiveAt, true)],
    ['牌局 AI / 等候陪聊', `${STATES[room.aiState] || '未知'} / ${STATES[room.chatState] || '未知'}`],
    ['播放确认', room.playback ? `${count(room.playback.pendingAcks)} / ${count(room.playback.totalHumans)} 位真人待确认` : '当前无播放等待']
  ];
  const players = (Array.isArray(room.players) ? room.players : []).map(player => `<div class="player"><span class="player-seat">${count(player.seat)}</span><span class="player-copy"><span class="player-name" title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</span><span class="player-state">${player.bot ? 'AI 玩家' : player.connected ? '真人 · 在线' : '真人 · 离线'}${room.phase !== 'lobby' ? player.alive ? ' · 存活' : ' · 已出局' : ''}</span></span></div>`).join('');
  return `<div class="detail-heading"><h3>${escapeHtml(roomLabel(room.roomId))} · 房间详情</h3><button class="quiet" type="button" data-close-detail aria-label="收起房间详情">收起 ×</button></div><div class="detail-grid">${fields.map(([label, value]) => `<div class="detail-item">${label}<strong>${escapeHtml(value)}</strong></div>`).join('')}</div><div class="players">${players}</div><p class="detail-note">显示公开席位与连接状态；不展示隐藏身份、夜间行动对象或发言内容。</p>`;
}
export function aiHtml(ai = {}) {
  const known = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const metric = value => known(value) ? count(value) : '—';
  const calls = count(ai.callsLastHour), max = count(ai.maxCallsPerHour), failures = count(ai.failures);
  const budgetKnown = known(ai.callsLastHour) && known(ai.maxCallsPerHour) && max > 0;
  const exhausted = budgetKnown && calls >= max;
  const hasRecentFailure = ai.lastFailureAt && (!ai.lastSuccessAt || new Date(ai.lastFailureAt).getTime() > new Date(ai.lastSuccessAt).getTime());
  const label = !ai.configured ? '尚未配置 AI 服务' : exhausted ? '本小时调用额度已用尽' : hasRecentFailure ? '最近一次请求异常' : count(ai.inFlight) ? `${count(ai.inFlight)} 个请求进行中` : ai.lastSuccessAt ? '最近请求成功' : '已配置 · 等待首次请求';
  const warning = !ai.configured || exhausted || hasRecentFailure;
  return `<p class="ai-health ${warning ? 'warning' : ''}"><span class="status-dot" aria-hidden="true"></span>${label}</p><p class="ai-model">${escapeHtml(ai.model || '未指定模型')}</p><div class="budget"><p class="metric-line"><span>最近 1 小时调用</span><b>${metric(ai.callsLastHour)} / ${metric(ai.maxCallsPerHour)}</b></p>${budgetKnown ? `<progress value="${Math.min(calls, max)}" max="${max}" aria-label="最近一小时 AI 调用额度"></progress>` : '<p class="budget-note">额度数据暂不可用</p>'}<p class="budget-note">牌局与小月陪聊共享额度</p></div><div class="ai-metrics"><div><strong>${metric(ai.successes)}</strong><span>成功 · 本次运行</span></div><div class="${failures ? 'bad' : ''}"><strong>${metric(ai.failures)}</strong><span>失败 · 本次运行</span></div><div><strong>${metric(ai.cancellations)}</strong><span>取消 · 本次运行</span></div></div><p class="metric-line"><span>平均耗时 · 本次运行</span><b>${ai.averageLatencyMs === null || ai.averageLatencyMs === undefined ? '暂无' : `${(count(ai.averageLatencyMs) / 1000).toFixed(1)} 秒`}</b></p><p class="ai-small"><span>最近成功</span><span>${escapeHtml(timeLabel(ai.lastSuccessAt, true))}</span></p><p class="ai-small"><span>最近失败</span><span>${escapeHtml(timeLabel(ai.lastFailureAt, true))}</span></p>`;
}
export function eventsHtml(events) {
  if (!Array.isArray(events) || !events.length) return '<li class="event-empty">暂无运行动态，等待新的房间活动。</li>';
  return [...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 40).map(event => `<li class="event ${['error', 'warning'].includes(event.level) ? event.level : ''}"><p>${escapeHtml(event.message)}</p><span>${escapeHtml(timeLabel(event.at))}${event.roomId ? ` · ${escapeHtml(roomLabel(event.roomId))}` : ''}</span></li>`).join('');
}

// This controller owns every authenticated request and timer. An epoch makes a
// completed old request harmless even if a transport ignores AbortSignal.
export class AdminSession {
  constructor({ fetcher = globalThis.fetch.bind(globalThis), onChange = () => {}, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id), visible = true } = {}) {
    Object.assign(this, { fetcher, onChange, now, schedule, unschedule });
    this.state = { authenticated: false, checking: false, busy: false, visible, snapshot: null, updatedAt: null, stale: false, error: '' };
    this.epoch = 0; this.timer = null; this.request = null; this.disposed = false;
  }
  emit(patch) { if (this.disposed) return; Object.assign(this.state, patch); this.onChange({ ...this.state }); }
  clearTimer() { if (this.timer !== null) this.unschedule(this.timer); this.timer = null; }
  invalidate() { this.epoch++; this.clearTimer(); this.request?.abort(); this.request = null; }
  async json(path, options = {}) {
    const control = new AbortController(); this.request = control;
    const timeout = this.schedule(() => control.abort(), 12000);
    try {
      const response = await this.fetcher(`./api/${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, signal: control.signal });
      if (!response.ok) { const error = new Error('Request failed'); error.status = response.status; throw error; }
      return await response.json();
    } finally { this.unschedule(timeout); if (this.request === control) this.request = null; }
  }
  async authenticate(token) {
    if (this.disposed || this.state.busy || this.state.authenticated) return false;
    this.invalidate(); const epoch = this.epoch;
    this.emit({ checking: token === undefined, busy: true, error: '', snapshot: null, updatedAt: null, stale: false });
    let success = false;
    try {
      const data = await this.json(token === undefined ? 'session' : 'login', token === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (epoch !== this.epoch || this.disposed) return false;
      if (data.authenticated !== true && data.ok !== true) throw new Error('Invalid session');
      success = true; this.emit({ authenticated: true, error: '' });
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) return false;
      this.emit({ authenticated: false, error: error.status === 401 ? (token === undefined ? '' : '管理口令不正确，请重新输入。') : error.status === 429 ? '尝试过于频繁，请稍后再登录。' : '暂时无法连接管理服务，请稍后重试。' });
    } finally {
      if (epoch === this.epoch && !this.disposed) {
        this.emit({ checking: false, busy: false });
        if (success && this.state.visible) await this.refresh();
      }
    }
    return success;
  }
  async refresh() {
    if (this.disposed || !this.state.authenticated || !this.state.visible || this.state.busy) return;
    this.clearTimer(); const epoch = this.epoch; this.emit({ busy: true });
    try {
      const snapshot = await this.json('state');
      if (epoch !== this.epoch || this.disposed) return;
      if (!snapshot || !Array.isArray(snapshot.rooms) || !snapshot.summary || !snapshot.ai) throw new Error('Invalid snapshot');
      this.emit({ snapshot, updatedAt: this.now(), stale: false, error: '' });
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) return;
      if (error.status === 401) this.emit({ authenticated: false, snapshot: null, updatedAt: null, stale: false, error: '管理会话已失效，请重新登录。' });
      else this.emit({ stale: true, error: this.state.snapshot ? '状态更新中断，以下保留上次数据；恢复连接后会自动更新。' : '暂时无法读取服务状态，正在自动重试。' });
    } finally {
      if (epoch === this.epoch && !this.disposed) { this.emit({ busy: false }); this.queueRefresh(); }
    }
  }
  queueRefresh() {
    this.clearTimer();
    if (this.state.authenticated && this.state.visible && !this.disposed) this.timer = this.schedule(() => { this.timer = null; void this.refresh(); }, 5000);
  }
  setVisible(visible) {
    if (this.disposed || this.state.visible === visible) return;
    // Authentication itself may finish while hidden; only state polling pauses.
    if (!visible && this.state.authenticated) { this.invalidate(); this.emit({ visible: false, busy: false }); }
    else { this.emit({ visible }); if (visible && this.state.authenticated) void this.refresh(); }
  }
  async logout() {
    if (this.disposed) return;
    this.invalidate(); const epoch = this.epoch;
    this.emit({ authenticated: false, checking: false, snapshot: null, updatedAt: null, stale: false, error: '', busy: true });
    try { await this.json('logout', { method: 'POST' }); }
    catch (error) { if (epoch === this.epoch && !this.disposed && error.status !== 401) this.emit({ error: '退出请求未送达服务器。本页数据已清除，请恢复连接后重新退出，或关闭此浏览器。' }); }
    finally { if (epoch === this.epoch && !this.disposed) this.emit({ busy: false }); }
  }
  dispose() { this.invalidate(); this.disposed = true; }
}
