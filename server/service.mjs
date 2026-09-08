import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Game } from './game.mjs';
import { createAdmin } from './admin.mjs';
import { ServiceMonitor } from './monitor.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createService({ root, provider, admin: adminConfig = null, now = Date.now, random, durations, maxRooms = 12, maxConnections = 72, aiRetryDelayMs = 1500, previewOrigins = [], lobbyChatCooldownMs = 2000, lobbyChatTimeoutMs = 25000, joinTimeoutMs = 10000 } = {}) {
  const allowedPreviews = new Set(previewOrigins.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.origin !== value) throw new Error('预览来源必须是完整的本机 HTTP Origin');
    return url.origin;
  }));
  const rooms = new Map(); const credentials = new Map();
  const monitor = new ServiceMonitor({ now });
  const snapshot = () => monitor.snapshot({ rooms, connections: wss.clients, provider, maxRooms, maxConnections });
  const admin = createAdmin({ root, config: adminConfig, now, snapshot,
    onEvent: event => monitor.event(event.kind, event.message, { level: event.level }) });
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'");
    let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { res.writeHead(400); res.end(); return; }
    try { if (await admin.handle(req, res, pathname)) return; }
    catch (_) { if (!res.headersSent) { res.writeHead(500); res.end('Administration temporarily unavailable'); } else res.destroy(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if (pathname === '/werewolf/health' || pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ app: 'aiui-werewolf', ok: true, version: '0.1.2', aiConfigured: Boolean(provider), maxPlayers: 6 })); return;
    }
    if (pathname.startsWith('/werewolf/')) pathname = pathname.slice('/werewolf'.length);
    if (pathname === '/') pathname = '/web/index.html';
    if (['/main.js', '/style.css', '/speech.js'].includes(pathname)) pathname = '/web' + pathname;
    // Only public client assets. Never serve the workspace as a general file tree.
    if (!/^\/(?:web|lib|assets)\/[\w./-]+$/.test(pathname) || pathname.split('/').includes('..')) { res.writeHead(404); res.end('Not found'); return; }
    if (pathname === '/lib/config.js') {
      res.setHeader('Content-Type', MIME['.js']);
      res.end("export default { version: '0.1.2', url: '' };\n"); return;
    }
    const filename = path.resolve(root, '.' + pathname);
    if (!filename.startsWith(path.resolve(root) + path.sep) || !MIME[path.extname(filename)]) { res.writeHead(404); res.end(); return; }
    try {
      if (!fs.realpathSync(filename).startsWith(fs.realpathSync(root) + path.sep)) throw new Error();
      if (!fs.statSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error();
      res.setHeader('Content-Type', MIME[path.extname(filename)]);
      const data = fs.readFileSync(filename); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (_) { res.writeHead(404); res.end('Not found'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/werewolf/ws' || wss.clients.size >= maxConnections) { socket.destroy(); return; }
    // Browser connections must originate at this host. AIUI has no browser Origin.
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host && !allowedPreviews.has(req.headers.origin)) { socket.destroy(); return; } }
      catch (_) { socket.destroy(); return; }
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const send = (ws, value) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 131072) { ws.close(1008, 'Slow connection'); return; }
    ws.send(JSON.stringify(value));
  };
  const roomDirectory = () => {
    const rows = [...rooms.values()].map(room => ({ roomId: room.game.roomId, phase: room.game.phase,
      members: room.game.players.length, online: room.sockets.size, capacity: 6,
      canJoin: room.game.phase === 'lobby' && room.game.players.length < 6 }));
    if (!rooms.has('lobby')) rows.push({ roomId: 'lobby', phase: 'lobby', members: 0, online: 0, capacity: 6, canJoin: true });
    return rows.sort((a, b) => a.roomId === 'lobby' ? -1 : b.roomId === 'lobby' ? 1 : a.roomId.localeCompare(b.roomId));
  };
  let directorySnapshot = '';
  const publishDirectory = () => {
    const listing = roomDirectory(); const snapshot = JSON.stringify(listing);
    if (snapshot === directorySnapshot) return;
    directorySnapshot = snapshot;
    for (const ws of wss.clients) if (ws.wantsRooms) send(ws, { type: 'rooms', rooms: listing });
  };
  const chatView = room => room.game.phase === 'lobby' ? {
    messages: room.lobbyChat.messages.map(message => ({ ...message })), status: room.lobbyChat.status, error: room.lobbyChat.error,
  } : null;
  const broadcast = room => {
    room.lastActive = now();
    monitor.observe(room);
    for (const [id, ws] of room.sockets) send(ws, { type: 'state', state: { ...room.game.view(id), aiStatus: room.aiStatus || '', lobbyChat: chatView(room) } });
    publishDirectory();
  };
  const cancelLobbyChat = (room, clear = false) => {
    room.chatEpoch++;
    room.chatController?.abort(); room.chatController = null;
    if (room.chatTimer) clearTimeout(room.chatTimer); room.chatTimer = null;
    room.lobbyChat.status = 'idle'; room.lobbyChat.error = '';
    if (clear) { room.lobbyChat.messages = []; room.lastChatAt = undefined; }
  };
  const makeRoom = roomId => {
    // Numeric private tables have a fixed limit; the shared lobby has one reserved slot.
    if (roomId !== 'lobby' && [...rooms.keys()].filter(id => id !== 'lobby').length >= maxRooms) throw new Error('当前房间较多，请稍后再试');
    const room = { game: new Game({ roomId, now, random, durations }), sockets: new Map(), createdAt: now(), lastActive: now(), acks: new Set(),
      lobbyChat: { messages: [], status: 'idle', error: '' }, chatEpoch: 0 };
    rooms.set(roomId, room); return room;
  };
  const allocateRoomId = () => {
    const start = randomInt(10000);
    for (let offset = 0; offset < 10000; offset++) {
      const id = String((start + offset) % 10000).padStart(4, '0');
      if (!rooms.has(id)) return id;
    }
    throw new Error('暂时没有空闲房间号，请稍后再试');
  };
  const beginLobbyChat = (room, playerId, rawText) => {
    if (room.game.phase !== 'lobby') throw new Error('陪聊仅在等待开局时可用');
    const player = room.game.players.find(item => item.id === playerId && item.connected && !item.bot);
    if (!player) throw new Error('请先入座再和小月聊天');
    const text = typeof rawText === 'string' ? rawText.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
    if (!text || Array.from(text).length > 240) throw new Error('聊天内容须为一至 240 个字');
    if (room.lobbyChat.status === 'thinking') throw new Error('小月正在回复，请稍候');
    if (room.lastChatAt !== undefined && now() - room.lastChatAt < lobbyChatCooldownMs) throw new Error('请稍候再发一条消息');
    if (typeof provider?.chat !== 'function') throw new Error('小月暂时无法回应，请稍后再试');
    room.lastChatAt = now();
    room.lobbyChat.messages.push({ id: 'chat-' + randomUUID(), kind: 'human', name: player.name, text });
    room.lobbyChat.messages = room.lobbyChat.messages.slice(-20);
    room.lobbyChat.status = 'thinking'; room.lobbyChat.error = '';
    const epoch = ++room.chatEpoch; const controller = new AbortController(); room.chatController = controller;
    const history = room.lobbyChat.messages.map(message => ({ ...message }));
    const current = () => !room.closed && room.chatEpoch === epoch && room.game.phase === 'lobby' && room.sockets.size > 0;
    const finishError = () => { if (current()) { room.lobbyChat.status = 'error'; room.lobbyChat.error = '小月暂时无法回应，请稍后再试。'; broadcast(room); } };
    room.chatTimer = setTimeout(() => {
      if (!current()) return;
      controller.abort(); finishError(); room.chatEpoch++; room.chatController = null; room.chatTimer = null;
    }, lobbyChatTimeoutMs); room.chatTimer.unref?.();
    broadcast(room);
    (async () => {
      try {
        const reply = await provider.chat(history, { signal: controller.signal });
        if (!current() || controller.signal.aborted) return;
        const text = typeof reply?.text === 'string' ? reply.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
        if (!text || Array.from(text).length > 240) throw new Error('Invalid companion response');
        room.lobbyChat.messages.push({ id: 'chat-' + randomUUID(), kind: 'agent', name: '小月', text });
        room.lobbyChat.messages = room.lobbyChat.messages.slice(-20);
        room.lobbyChat.status = 'idle'; room.lobbyChat.error = '';
        broadcast(room);
      } catch (_) { if (!controller.signal.aborted) finishError(); }
      finally {
        if (room.chatEpoch === epoch) {
          if (room.chatTimer) clearTimeout(room.chatTimer); room.chatTimer = null; room.chatController = null;
        }
      }
    })();
  };
  // Connections and other players' private ballots may change revision without
  // changing this bot's one legal action. Do not bill for those harmless changes.
  const actionKey = pending => pending ? `${pending.context.round}:${pending.context.phase}:${pending.playerId}:${pending.kind}` : null;
  const pruneCredentials = room => {
    const retained = new Set(room.game.players.map(player => player.id));
    for (const [token, credential] of credentials) {
      if (credential.roomId === room.game.roomId && !retained.has(credential.playerId)) credentials.delete(token);
    }
  };
  const syncPlayback = room => {
    const speechId = room.game.speech?.id;
    if (room.game.phase !== 'playback' || !speechId) { room.playbackId = null; return; }
    if (room.playbackId !== speechId) { room.playbackId = speechId; room.acks = new Set(); }
    if (room.sockets.size && [...room.sockets.keys()].every(id => room.acks.has(id))) room.game.completePlayback(speechId);
  };
  const kick = room => {
    if (room.busy || room.closed || !room.sockets.size) return;
    const pending = room.game.pendingAI();
    if (!pending) return;
    const key = actionKey(pending);
    if (room.failedKey === key) return;
    if (!provider) { room.aiStatus = 'AI 尚未配置，无法开局'; broadcast(room); return; }
    room.busy = true;
    room.aiActionKey = key;
    room.aiStatus = pending.context.phase === 'night' ? 'AI 正在处理夜晚行动' :
      pending.context.phase === 'vote' ? 'AI 正在投票' : `${pending.context.selfSeat} 号 AI 正在思考`;
    const controller = new AbortController(); room.controller = controller;
    broadcast(room);
    (async () => {
      try {
        let action;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { action = await provider.decide(pending, { signal: controller.signal }); break; }
          catch (error) {
            if (attempt || controller.signal.aborted) throw error;
            await new Promise(resolve => { const handle = setTimeout(resolve, aiRetryDelayMs); handle.unref?.(); });
          }
        }
        const current = room.game.pendingAI();
        if (!room.closed && room.sockets.size && actionKey(current) === key) {
          room.game.act(pending.playerId, action); room.aiStatus = ''; room.failedKey = null;
        }
      } catch (error) {
        if (!room.closed && !controller.signal.aborted && actionKey(room.game.pendingAI()) === key) {
          room.failedKey = key; room.aiStatus = 'AI 暂时无法回应；本轮会在倒计时结束后跳过。';
        }
      } finally {
        room.busy = false; room.controller = null;
        if (!room.closed) { syncPlayback(room); broadcast(room); setImmediate(() => kick(room)); }
      }
    })();
  };
  const cancelObsoleteAI = room => {
    if (room.busy && actionKey(room.game.pendingAI()) !== room.aiActionKey) room.controller?.abort();
  };
  const updated = room => { pruneCredentials(room); syncPlayback(room); cancelObsoleteAI(room); broadcast(room); kick(room); };
  const detach = (ws, explicit = false) => {
    const room = ws.room; if (!room || room.sockets.get(ws.playerId) !== ws) return;
    room.sockets.delete(ws.playerId);
    if (explicit) {
      const wasLobby = room.game.phase === 'lobby';
      room.game.leave(ws.playerId);
      if (wasLobby) credentials.delete(ws.resumeToken);
    } else room.game.setConnected(ws.playerId, false);
    ws.room = null;
    if (explicit && room.game.phase === 'lobby' && room.game.players.length === 0) {
      room.closed = true; room.controller?.abort(); cancelLobbyChat(room, true);
      rooms.delete(room.game.roomId); pruneCredentials(room); monitor.removed(room.game.roomId, 'empty'); publishDirectory(); return;
    }
    if (!room.sockets.size) {
      room.pausedAt = now();
      room.aiStatus = '';
      room.controller?.abort();
      cancelLobbyChat(room);
    }
    updated(room);
  };
  wss.on('connection', ws => {
    ws.count = 0; ws.window = now(); ws.alive = true;
    const joinTimeout = setTimeout(() => { if (!ws.room) ws.close(1008, 'Join required'); }, joinTimeoutMs);
    joinTimeout.unref?.();
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw, binary) => {
      let requestType;
      try {
        if (binary) throw new Error('仅支持游戏消息');
        if (now() - ws.window > 10000) { ws.window = now(); ws.count = 0; }
        if (++ws.count > 100) { ws.close(1008, 'Rate limit'); return; }
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('消息格式无效');
        if (['ping', 'rooms', 'join', 'create', 'leave', 'lobby_chat', 'start', 'restart', 'action', 'speech_done'].includes(msg.type)) requestType = msg.type;
        if (msg.type === 'ping') { send(ws, { type: 'pong' }); return; }
        if (msg.type === 'rooms') {
          ws.wantsRooms = true; clearTimeout(joinTimeout);
          send(ws, { type: 'rooms', rooms: roomDirectory() }); return;
        }
        if (msg.type === 'join' || msg.type === 'create') {
          if (ws.room) throw new Error('请先退出当前房间');
          const roomId = msg.type === 'create' ? allocateRoomId() : msg.roomId;
          if (typeof roomId !== 'string' || !/^(?:\d{4}|lobby)$/.test(roomId)) throw new Error('房间号必须是四位数字');
          let room = rooms.get(roomId);
          let playerId, resumeToken;
          if (msg.type === 'join' && msg.resumeToken) {
            const credential = credentials.get(msg.resumeToken);
            if (!credential || credential.roomId !== roomId || !room || !room.game.players.some(p => p.id === credential.playerId)) {
              if (credential && credential.roomId === roomId) credentials.delete(msg.resumeToken);
              send(ws, { type: 'error', requestType, code: 'RESUME_EXPIRED', message: '原座位已失效，请清除重连记录后重新加入' }); return;
            }
            playerId = credential.playerId; resumeToken = msg.resumeToken;
          } else {
            if (!room) {
              if (msg.type === 'join' && roomId !== 'lobby' && msg.createIfMissing === false) {
                send(ws, { type: 'error', requestType, code: 'ROOM_NOT_FOUND', message: '这个房间还不存在，请先创建房间' }); return;
              }
              room = makeRoom(roomId);
            }
            playerId = randomUUID();
            room.game.join({ id: playerId, name: String(msg.name || '玩家').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16) || '玩家' });
            resumeToken = randomBytes(32).toString('hex');
            credentials.set(resumeToken, { roomId, playerId });
          }
          const previous = room.sockets.get(playerId);
          if (!room.sockets.size && room.pausedAt !== undefined) {
            if (room.game.deadline !== null) {
              room.game.deadline += Math.max(0, now() - room.pausedAt);
              room.game.revision++;
            }
            delete room.pausedAt;
          }
          room.sockets.set(playerId, ws);
          ws.room = room; ws.playerId = playerId; ws.resumeToken = resumeToken;
          previous?.close(1000, 'Seat resumed');
          room.game.setConnected(playerId, true); clearTimeout(joinTimeout);
          send(ws, { type: 'welcome', roomId, playerId, resumeToken }); updated(room); return;
        }
        const room = ws.room;
        if (!room || room.sockets.get(ws.playerId) !== ws) throw new Error('请先加入房间');
        if (msg.type === 'leave') { detach(ws, true); ws.close(1000); return; }
        if (msg.type === 'lobby_chat') { beginLobbyChat(room, ws.playerId, msg.text); return; }
        if (msg.type === 'start') {
          if (!provider) throw new Error('DeepSeek 尚未配置，暂不能开启 AI 陪玩');
          room.game.start(ws.playerId);
          cancelLobbyChat(room, true);
        } else if (msg.type === 'restart') { room.game.restart(ws.playerId); cancelLobbyChat(room, true); }
        else if (msg.type === 'action') {
          if (msg.revision !== room.game.revision) throw new Error('房间进度已更新，请按当前提示重新操作');
          room.game.act(ws.playerId, msg.action);
        } else if (msg.type === 'speech_done') {
          if (room.game.phase === 'playback' && room.game.speech?.id === msg.speechId) { syncPlayback(room); room.acks.add(ws.playerId); }
        } else throw new Error('不支持的操作');
        updated(room);
      } catch (error) {
        // Engine errors are fixed, user-facing validation strings, never provider payloads.
        send(ws, { type: 'error', requestType, message: error instanceof SyntaxError ? '消息格式无效' : error.message || '操作失败' });
        if (ws.room) broadcast(ws.room);
      }
    });
    ws.on('close', () => { clearTimeout(joinTimeout); detach(ws); });
    ws.on('error', () => {});
  });
  const timer = setInterval(() => {
    for (const [id, room] of rooms) {
      if (!room.sockets.size) {
        if (now() - room.lastActive > 30 * 60 * 1000) {
          room.closed = true; room.controller?.abort(); cancelLobbyChat(room, true); rooms.delete(id);
          monitor.removed(id, 'expired');
          for (const [token, cred] of credentials) if (cred.roomId === id) credentials.delete(token);
          publishDirectory();
        }
        continue;
      }
      const revision = room.game.revision;
      room.game.tick(); syncPlayback(room); cancelObsoleteAI(room);
      if (revision !== room.game.revision) broadcast(room);
      kick(room);
    }
  }, 300); timer.unref();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 30000); heartbeat.unref();
  return { server, rooms, wss,
    listen: (port = 8790, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: async () => {
      clearInterval(timer); clearInterval(heartbeat);
      admin.close();
      for (const room of rooms.values()) { room.closed = true; room.controller?.abort(); cancelLobbyChat(room, true); }
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  };
}
