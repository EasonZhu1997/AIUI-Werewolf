import { AdminSession, count, durationLabel, timeLabel, filteredRooms, summaryHtml, roomsHtml, roomDetailHtml, aiHtml, eventsHtml } from './view.js';

const $ = id => document.getElementById(id);
const markupCache = new Map();
function writeHtml(id, html) {
  // A status poll must not discard a focused room button when its visible
  // content did not change. Search and open-detail choices keep their nodes.
  if (markupCache.get(id) === html) return;
  markupCache.set(id, html); $(id).innerHTML = html;
}
let selectedRoomId = '', renderedSnapshot = null, previousAuthenticated = false;
function renderRooms(snapshot) {
  const query = $('roomSearch').value, filter = $('phaseFilter').value;
  const rooms = filteredRooms(snapshot.rooms, query, filter);
  $('roomCount').textContent = `${rooms.length} / ${snapshot.rooms.length} 桌`;
  writeHtml('roomList', roomsHtml(rooms, selectedRoomId, !!query.trim() || filter !== 'all'));
  const selected = snapshot.rooms.find(room => room.roomId === selectedRoomId);
  if (!selected) selectedRoomId = '';
  $('roomDetail').hidden = !selected;
  writeHtml('roomDetail', roomDetailHtml(selected));
}
function render(state) {
  $('loginView').hidden = state.authenticated;
  $('dashboard').hidden = !state.authenticated;
  $('logout').hidden = !state.authenticated;
  $('loginButton').disabled = state.busy || state.checking;
  $('token').disabled = state.busy || state.checking;
  $('loginStatus').textContent = state.checking ? '正在确认登录状态…' : state.busy && !state.authenticated ? '正在处理，请稍候…' : state.error;
  $('loginStatus').classList.toggle('error', !!state.error);
  if (previousAuthenticated !== state.authenticated) {
    $('token').value = '';
    if (!state.authenticated) { selectedRoomId = ''; $('roomSearch').value = ''; $('phaseFilter').value = 'all'; }
  }
  previousAuthenticated = state.authenticated;
  $('refresh').disabled = state.busy;
  $('dashboard').dataset.stale = String(state.stale);
  $('connectionNotice').hidden = !state.error;
  $('connectionNotice').textContent = state.error;
  $('connectionNotice').classList.toggle('error', state.stale);
  $('refreshStatus').textContent = !state.visible ? '页面已隐藏 · 暂停刷新' : state.busy ? '正在更新状态…' : state.updatedAt ? `${state.stale ? '上次更新' : '已更新'} ${timeLabel(state.updatedAt)} · 每 5 秒` : '每 5 秒自动刷新';
  if (!state.snapshot) {
    renderedSnapshot = null;
    for (const id of ['summary', 'roomList', 'roomDetail', 'aiState', 'eventList']) { $(id).replaceChildren(); markupCache.delete(id); }
    $('roomDetail').hidden = true; $('roomCount').textContent = ''; $('serviceMeta').textContent = '正在读取服务状态';
    return;
  }
  if (renderedSnapshot === state.snapshot) return;
  renderedSnapshot = state.snapshot;
  const s = state.snapshot;
  $('adminVersion').textContent = s.adminVersion || '0.1.0';
  $('serviceMeta').textContent = `游戏服务 ${s.version || '—'} · 已运行 ${durationLabel(s.uptimeMs)} · 每桌 ${count(s.limits?.maxPlayers) || 6} 席`;
  writeHtml('summary', summaryHtml(s));
  renderRooms(s);
  writeHtml('aiState', aiHtml(s.ai));
  writeHtml('eventList', eventsHtml(s.events));
}
const session = new AdminSession({ visible: !document.hidden, onChange: render });
$('loginForm').addEventListener('submit', event => {
  event.preventDefault();
  const token = $('token').value;
  if (!token) return;
  $('token').value = '';
  void session.authenticate(token);
});
$('logout').addEventListener('click', () => { $('token').value = ''; void session.logout(); });
$('refresh').addEventListener('click', () => void session.refresh());
for (const id of ['roomSearch', 'phaseFilter']) $(id).addEventListener(id === 'roomSearch' ? 'input' : 'change', () => { if (session.state.snapshot) renderRooms(session.state.snapshot); });
$('roomList').addEventListener('click', event => {
  const button = event.target.closest('button[data-room]');
  if (!button || !session.state.snapshot) return;
  selectedRoomId = selectedRoomId === button.dataset.room ? '' : button.dataset.room;
  renderRooms(session.state.snapshot);
});
$('roomDetail').addEventListener('click', event => {
  if (event.target.closest('[data-close-detail]') && session.state.snapshot) { selectedRoomId = ''; renderRooms(session.state.snapshot); }
});
document.addEventListener('visibilitychange', () => session.setVisible(!document.hidden));
window.addEventListener('pagehide', () => session.setVisible(false));
window.addEventListener('pageshow', event => { if (event.persisted) { if (!session.state.authenticated) void session.authenticate(); session.setVisible(!document.hidden); } });
void session.authenticate();
