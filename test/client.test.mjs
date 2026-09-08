import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/^export /gm, '');
function harness() {
  const cleared = []; const sent = []; const sockets = [];
  const GameClient = vm.runInNewContext(source + '\nGameClient;', {
    setInterval: () => 17,
    clearInterval: id => { assert.ok(Number.isInteger(id), 'AIUI timers require a real integer handle'); cleared.push(id); },
  });
  const client = new GameClient({ url: 'ws://127.0.0.1:8790/werewolf/ws', socketFactory: () => {
    const hooks = {}; const socket = { hooks, onOpen: fn => { hooks.open = fn; }, onClose: fn => { hooks.close = fn; },
      onMessage: fn => { hooks.message = fn; }, onError: fn => { hooks.error = fn; }, send: data => { assert.equal(typeof data, 'string', 'AIUI SocketTask.send accepts raw string, not options object'); sent.push(JSON.parse(data)); }, close: () => {} };
    sockets.push(socket); return socket;
  } });
  return { client, cleared, sent, sockets };
}
test('fresh AIUI page can disconnect/join with strict timer handles', () => {
  const { client, cleared, sent, sockets } = harness();
  client.disconnect(); client.join({ roomId: '0037', name: 'eye' });
  assert.deepEqual(cleared, []);
  sockets[0].hooks.open(); assert.equal(sent[0].type, 'join');
  client.disconnect(); assert.deepEqual(cleared, [17]);
  client.disconnect(); assert.deepEqual(cleared, [17]);
});
test('stale socket events cannot reopen or mutate a new room', () => {
  const { client, sent, sockets } = harness();
  client.join({ roomId: '0037', name: 'eye' });
  client.join({ roomId: '0038', name: 'eye' });
  sockets[0].hooks.open(); sockets[0].hooks.message({ data: '{"type":"state","state":{"roomId":"0037"}}' });
  assert.equal(client.state, null); assert.deepEqual(sent, []);
  sockets[1].hooks.open(); assert.equal(sent[0].roomId, '0038');
});

test('AIUI delivers raw message strings while browser delivers MessageEvent data', () => {
  const { client, sockets } = harness();
  client.join({ roomId: '0037', name: 'eye' });
  sockets[0].hooks.message('{"type":"state","state":{"roomId":"0037","revision":1}}');
  assert.equal(client.state.revision, 1);
  sockets[0].hooks.message({ data: '{"type":"state","state":{"roomId":"0037","revision":2}}' });
  assert.equal(client.state.revision, 2);
});

test('directory subscription has no seat and stops delivering after creating a room', () => {
  const { client, sockets, sent, cleared } = harness();
  const directories = []; client.onRooms = rooms => directories.push(rooms);
  client.browse(); sockets[0].hooks.open();
  assert.equal(sent[0].type, 'rooms'); assert.equal(client.welcome, null);
  sockets[0].hooks.message('{"type":"rooms","rooms":[{"roomId":"0042","members":1,"canJoin":true}]}');
  assert.equal(directories.length, 1); assert.equal(client.rooms[0].roomId, '0042');
  client.refreshRooms(); assert.equal(sent[1].type, 'rooms');
  client.create({ name: '一起玩' }); sockets[1].hooks.open();
  assert.deepEqual(sent[2], { type: 'create', name: '一起玩' });
  sockets[0].hooks.message('{"type":"rooms","rooms":[]}');
  assert.equal(directories.length, 1); assert.deepEqual(cleared, [17]);
  sockets[1].hooks.message('{"type":"welcome","roomId":"0048","playerId":"p","resumeToken":"test-token"}');
  assert.equal(client.welcome.roomId, '0048');
  assert.throws(() => client.refreshRooms(), /等待大厅/);
});

test('explicit join and lobby chat remain separate from revisioned game actions', () => {
  const { client, sockets, sent } = harness();
  client.join({ roomId: '0007', name: '眼镜玩家', createIfMissing: false, type: 'start' }); sockets[0].hooks.open();
  assert.deepEqual(sent[0], { type: 'join', roomId: '0007', name: '眼镜玩家', createIfMissing: false });
  sockets[0].hooks.message('{"type":"state","state":{"revision":9}}');
  client.chat('小月，教我怎么玩。');
  assert.deepEqual(sent[1], { type: 'lobby_chat', text: '小月，教我怎么玩。' });
  client.sendAction({ kind: 'vote', action: 'skip', target: null });
  assert.equal(sent[2].revision, 9); assert.equal(sent[2].type, 'action');
});

test('error request type reaches both clients so a late chat error cannot masquerade as a start failure', () => {
  const { client, sockets } = harness();
  const errors = []; client.onStatus = () => { if (client.lastError) errors.push(client.lastError.requestType); };
  client.join({ roomId: '0007' });
  sockets[0].hooks.message('{"type":"error","requestType":"lobby_chat","message":"请稍候"}');
  sockets[0].hooks.message({ data: '{"type":"error","requestType":"start","message":"暂不能开局"}' });
  assert.deepEqual(errors, ['lobby_chat', 'start']);
});
