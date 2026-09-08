import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game.mjs';

function table({ humans = 6, random = () => 0.999, durations = {} } = {}) {
  let now = 1000;
  const game = new Game({ roomId: '0037', random, now: () => now, durations: { night: 100, speech: 100, playback: 100, vote: 100, ...durations } });
  for (let seat = 1; seat <= humans; seat++) game.join({ id: `h${seat}`, name: `玩家${seat}` });
  return { game, advance(ms = 100) { now += ms; return game.tick(); } };
}
const id = (g, seat) => g.players.find(p => p.seat === seat).id;
const night = (g, seat, action, target = null) => g.act(id(g, seat), { kind: 'night', action, target });
const skipNight = g => {
  let safety = 20;
  while (g.phase === 'night' && safety--) {
    const p = g.players.find(p => g.view(p.id).prompt?.kind === 'night');
    assert.ok(p, 'night must have an actionable player');
    night(g, p.seat, 'skip');
  }
};
const skipSpeech = (g, advance) => {
  while (g.phase === 'speech' || g.phase === 'playback') advance();
  assert.equal(g.phase, 'vote');
};
const vote = (g, seat, target = null) => g.act(id(g, seat), { kind: 'vote', action: target === null ? 'skip' : 'vote', target });
const eliminate = (g, seat) => {
  for (const player of [...g.players].filter(p => p.alive)) vote(g, player.seat, player.seat === seat ? null : seat);
};

test('one human can start a full six-seat table with the exact role composition', () => {
  const { game: g } = table({ humans: 1 });
  assert.equal(g.view('h1').canStart, true);
  g.start('h1');
  assert.equal(g.players.length, 6);
  assert.equal(g.players.filter(p => p.bot).length, 5);
  assert.deepEqual(g.players.map(p => p.role), ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager']);
  assert.equal(g.phase, 'night');
  assert.equal(g.round, 1);
  assert.equal(g.pendingAI().playerId, id(g, 3), 'solo first night starts with the seer');
});

test('room validation, seat limit, names, and online human authority', () => {
  assert.throws(() => new Game({ roomId: '37' }));
  assert.throws(() => new Game({ roomId: '0037', durations: { night: 0 } }));
  assert.equal(new Game({ roomId: 'lobby' }).phase, 'lobby');
  const { game: g } = table();
  assert.throws(() => g.join({ id: 'extra', name: '第七人' }), /最多六人/);
  assert.throws(() => g.join({ id: 'h1', name: '重复' }), /身份/);
  assert.equal(g.view('h2').canStart, true);
  assert.throws(() => g.start('unknown'), /在线真人/);
  g.leave('h2');
  assert.equal(g.join({ id: 'new', name: '\u0000 测试\u0007 ' }), 2);
  assert.equal(g.players.find(p => p.id === 'new').name, '测试');
  g.start('h1');
  assert.throws(() => g.join({ id: 'late', name: '迟到' }), /已经|已开始/);
  assert.throws(() => g.start('h1'), /已经/);
});

test('host transfers on disconnect and lobby departure preserves free seat assignment', () => {
  const { game: g } = table({ humans: 3 });
  const rev = g.revision;
  assert.equal(g.setConnected('h1', false), true);
  assert.equal(g.hostId, 'h2');
  assert.equal(g.revision, rev + 1);
  assert.equal(g.setConnected('h1', false), false);
  g.leave('h2');
  assert.equal(g.hostId, 'h3');
  assert.equal(g.join({ id: 'h4', name: '新人' }), 2);
  g.start('h3');
  assert.equal(g.players.some(p => p.id === 'h1'), false);
  assert.equal(g.players.length, 6);
});

test('unknown and disconnected players cannot act or obtain a view', () => {
  const { game: g } = table(); g.start('h1');
  assert.throws(() => g.view('intruder'), /不在房间/);
  assert.throws(() => g.act('intruder', { kind: 'night', action: 'kill', target: 5 }));
  g.setConnected('h1', false);
  assert.equal(g.view('h1').prompt, null);
  assert.throws(() => night(g, 1, 'kill', 5), /无法行动/);
  assert.equal(g.setConnected('unknown', false), false);
});

test('roles and witch resources remain private before the result; projections cannot mutate state', () => {
  const { game: g } = table(); g.start('h1');
  for (const player of g.players) {
    const view = g.view(player.id);
    assert.deepEqual(view.players.filter(p => 'role' in p).map(p => p.id), [player.id]);
    if (player.role !== 'witch') assert.equal('potions' in view.self, false);
    if (player.role !== 'wolf') assert.equal(view.self.clues.some(c => c.includes('狼队友')), false);
  }
  const view = g.view('h3');
  view.players[0].alive = false;
  view.players.push({ id: 'attack' });
  view.self.clues.push('forged');
  view.logs[0].text = 'forged';
  assert.equal(g.players[0].alive, true);
  assert.equal(g.players.length, 6);
  assert.deepEqual(g.view('h3').self.clues, []);
  assert.notEqual(g.logs[0].text, 'forged');
});

test('night ballots cannot target wolf teammates, dead seats, or invalid action kinds', () => {
  const { game: g } = table(); g.start('h1');
  const rev = g.revision;
  assert.throws(() => night(g, 1, 'kill', 2), /目标/);
  assert.throws(() => night(g, 1, 'kill', 7), /目标/);
  assert.throws(() => night(g, 1, 'kill', '5'), /目标/);
  assert.throws(() => night(g, 3, 'inspect', 1), /回合/);
  assert.throws(() => g.act('h1', { kind: 'vote', action: 'vote', target: 5 }), /回合/);
  assert.equal(g.revision, rev);
  night(g, 1, 'kill', 5);
  assert.equal(g.view('h1').prompt, null);
  assert.throws(() => night(g, 1, 'kill', 6), /回合/);
});

test('wolf tie uses the injected draw; seer learns only faction, and the witch privately sees the threatened victim', () => {
  const { game: g } = table(); g.start('h1');
  g.random = () => 0;
  night(g, 1, 'kill', 6); night(g, 2, 'kill', 5);
  assert.equal(g.view('h3').prompt.kind, 'night');
  night(g, 3, 'inspect', 4);
  const witch = g.view('h4');
  assert.equal(witch.self.potions.threatenedSeat, 5);
  assert.ok(witch.prompt.choices.some(c => c.action === 'save' && c.target === 5));
  assert.match(g.view('h3').self.clues[0], /4 号.*好人阵营/);
  assert.doesNotMatch(g.view('h3').self.clues[0], /女巫/);
  assert.equal(g.view('h5').self.clues.length, 0);
  assert.equal(JSON.stringify(g.view('h5')).includes('threatenedSeat'), false);
  assert.equal(g.logs.some(l => /袭击|查验|解药/.test(l.text)), false);
  night(g, 4, 'skip');
  assert.equal(g.players.find(p => p.seat === 5).alive, false);
  assert.equal(g.players.find(p => p.seat === 6).alive, true);
  assert.equal(g.phase, 'speech');
});

test('seer may inspect wolves and gets no inspection when skipping', () => {
  const { game: g } = table(); g.start('h1');
  night(g, 1, 'skip'); night(g, 2, 'skip');
  assert.throws(() => night(g, 3, 'inspect', 3), /目标/);
  night(g, 3, 'inspect', 2);
  assert.match(g.view('h3').self.clues[0], /狼人阵营/);
  assert.equal(g.view('h1').self.clues.length, 1); // teammate clue, not inspection
});

test('witch may save herself, consumes only the selected potion and cannot act twice', () => {
  const { game: g, advance } = table(); g.start('h1');
  night(g, 1, 'kill', 4); night(g, 2, 'kill', 4); night(g, 3, 'skip');
  night(g, 4, 'save', 4);
  assert.equal(g.players.every(p => p.alive), true);
  assert.deepEqual(g.view('h4').self.potions, { save: false, poison: true });
  assert.throws(() => night(g, 4, 'poison', 1), /回合/);
  skipSpeech(g, advance);
  for (const p of [...g.players]) vote(g, p.seat);
  night(g, 1, 'kill', 5); night(g, 2, 'kill', 5); night(g, 3, 'skip');
  const witch = g.view('h4');
  assert.equal('threatenedSeat' in witch.self.potions, false);
  assert.equal(witch.prompt.choices.some(c => c.action === 'save'), false);
  night(g, 4, 'poison', 1);
  assert.equal(g.players.find(p => p.seat === 1).alive, false);
  assert.equal(g.players.find(p => p.seat === 5).alive, false);
  assert.deepEqual(g.view('h4').self.potions, { save: false, poison: false });
});

test('night deaths resolve together and a threatened witch can poison before dying', () => {
  const { game: g } = table(); g.start('h1');
  night(g, 1, 'kill', 4); night(g, 2, 'kill', 4); night(g, 3, 'skip');
  assert.equal(g.players.find(p => p.seat === 4).alive, true);
  night(g, 4, 'poison', 1);
  assert.equal(g.players.find(p => p.seat === 4).alive, false);
  assert.equal(g.players.find(p => p.seat === 1).alive, false);
  assert.equal(g.phase, 'speech');
  assert.equal(g.view('h1').prompt, null);
  assert.equal(g.view('h4').prompt, null);
  assert.equal(g.view('h5').players.some(p => 'role' in p && p.id !== 'h5'), false);
});

test('double death reaching wolf parity ends the game and reveals all roles', () => {
  const { game: g } = table(); g.start('h1');
  night(g, 1, 'kill', 5); night(g, 2, 'kill', 5); night(g, 3, 'skip'); night(g, 4, 'poison', 6);
  assert.equal(g.phase, 'result');
  assert.equal(g.result.winner, 'wolves');
  assert.equal(g.deadline, null);
  assert.equal(g.view('h3').players.filter(p => p.role).length, 6);
  assert.equal(g.pendingAI(), null);
});

test('speech is ordered, bounded, acknowledged by ID and preserved as public dialogue', () => {
  const { game: g } = table(); g.start('h1'); skipNight(g);
  assert.equal(g.phase, 'speech');
  assert.equal(g.view('h1').prompt.kind, 'speech');
  assert.equal(g.view('h2').prompt, null);
  assert.throws(() => g.act('h2', { kind: 'speech', text: '抢话' }), /回合/);
  assert.throws(() => g.act('h1', { kind: 'speech', text: ' ' }));
  assert.throws(() => g.act('h1', { kind: 'speech', text: '字'.repeat(241) }));
  g.act('h1', { kind: 'speech', text: ' 我是村民。 ' });
  assert.equal(g.phase, 'playback');
  assert.equal(g.speech.text, '我是村民。');
  const first = g.speech.id;
  assert.equal(g.completePlayback('wrong-id'), false);
  assert.equal(g.phase, 'playback');
  assert.equal(g.completePlayback(first), true);
  assert.equal(g.completePlayback(first), false);
  assert.equal(g.view('h2').prompt.kind, 'speech');
  g.act('h2', { kind: 'speech', text: '我听到了。' });
  assert.notEqual(g.speech.id, first);
  assert.ok(g.view('h6').logs.some(l => l.text.includes('我是村民。')));
});

test('votes stay private until all votes finish, then publish tally and eliminate unique top vote', () => {
  const { game: g, advance } = table(); g.start('h1'); skipNight(g); skipSpeech(g, advance);
  vote(g, 1, 2);
  assert.equal(g.view('h1').prompt, null);
  assert.equal(g.view('h3').logs.some(l => l.text.includes('→')), false);
  assert.equal('votes' in g.view('h3'), false);
  assert.throws(() => vote(g, 1, 3), /回合/);
  assert.throws(() => vote(g, 2, 2), /目标/);
  for (const seat of [2, 3, 4, 5, 6]) vote(g, seat, seat === 2 ? null : 2);
  assert.equal(g.players.find(p => p.seat === 2).alive, false);
  assert.equal(g.round, 2);
  assert.equal(g.phase, 'night');
  assert.ok(g.logs.some(l => l.text.includes('1号→2号')));
  assert.equal(g.view('h4').players.some(p => p.seat === 2 && 'role' in p), false);
});

test('tied votes and all abstentions eliminate nobody', () => {
  const { game: g, advance } = table(); g.start('h1'); skipNight(g); skipSpeech(g, advance);
  vote(g, 1, 2); vote(g, 2, 1); vote(g, 3, 1); vote(g, 4, 2); vote(g, 5); vote(g, 6);
  assert.equal(g.players.filter(p => p.alive).length, 6);
  assert.ok(g.logs.some(l => l.text.includes('平票，无人')));
  skipNight(g); skipSpeech(g, advance);
  for (const p of g.players) vote(g, p.seat);
  assert.equal(g.players.filter(p => p.alive).length, 6);
  assert.ok(g.logs.some(l => l.text.includes('全部弃票')));
});

test('all wolves eliminated gives village victory and an eliminated non-host human can restart', () => {
  const { game: g, advance } = table(); g.start('h1'); skipNight(g); skipSpeech(g, advance);
  eliminate(g, 1);
  assert.equal(g.phase, 'night');
  skipNight(g); skipSpeech(g, advance); eliminate(g, 2);
  assert.equal(g.phase, 'result');
  assert.equal(g.result.winner, 'villagers');
  assert.equal(g.view('h1').canRestart, true);
  assert.equal(g.view('h2').canRestart, true);
  assert.throws(() => g.restart('unknown'), /在线真人/);
  g.setConnected('h6', false);
  g.restart('h2');
  assert.equal(g.phase, 'lobby');
  assert.equal(g.players.length, 5);
  assert.equal(g.players.every(p => p.alive && p.role === null && !p.bot), true);
  assert.equal(g.view('h1').self, null);
  assert.equal(g.view('h1').logs.length, 0);
  g.start('h1');
  assert.equal(g.players.length, 6);
  assert.equal(g.players.find(p => p.seat === 6).bot, true);
});

test('start and restart permissions require an online human seat, never a host claim or AI ID', () => {
  const { game: g } = table({ humans: 2 });
  assert.equal(g.hostId, 'h1'); assert.equal(g.view('h2').canStart, true);
  g.setConnected('h2', false);
  assert.equal(g.view('h2').canStart, false);
  assert.throws(() => g.start('h2'), /在线真人/);
  assert.throws(() => g.start('unknown'), /在线真人/);
  g.setConnected('h2', true); g.start('h2');
  assert.equal(g.phase, 'night');
  const bot = g.players.find(p => p.bot);
  assert.equal(g.view(bot.id).canStart, false);
  assert.equal(g.view(bot.id).canRestart, false);
  assert.throws(() => g.start(bot.id), /在线真人/);
  assert.throws(() => g.restart(bot.id), /在线真人/);
  g.setConnected('h1', false);
  assert.throws(() => g.restart('h1'), /在线真人/);
});

test('restart discards bots and rejects a midgame reset', () => {
  const { game: g, advance } = table({ humans: 1 }); g.start('h1');
  assert.throws(() => g.restart('h1'), /结束后/);
  skipNight(g); skipSpeech(g, advance); eliminate(g, 1);
  skipNight(g); skipSpeech(g, advance); eliminate(g, 2);
  assert.equal(g.phase, 'result');
  g.restart('h1');
  assert.deepEqual(g.players.map(p => p.id), ['h1']);
  assert.equal(g.view('h1').canStart, true);
});

test('a daytime mis-vote reaching parity also gives the wolves victory', () => {
  const { game: g, advance } = table(); g.start('h1');
  night(g, 1, 'kill', 5); night(g, 2, 'kill', 5); night(g, 3, 'skip'); night(g, 4, 'skip');
  skipSpeech(g, advance); eliminate(g, 6);
  assert.equal(g.phase, 'result');
  assert.equal(g.result.winner, 'wolves');
  assert.equal(g.round, 1);
});

test('dead role holders are skipped at night and the last wolf has no dead teammate ballot', () => {
  const { game: g, advance } = table(); g.start('h1');
  night(g, 1, 'kill', 3); night(g, 2, 'kill', 3); night(g, 3, 'skip'); night(g, 4, 'poison', 1);
  assert.equal(g.phase, 'speech');
  skipSpeech(g, advance);
  for (const p of g.players.filter(p => p.alive)) vote(g, p.seat);
  night(g, 2, 'kill', 5);
  assert.equal(g.view('h3').prompt, null);
  assert.equal(g.view('h4').prompt.kind, 'night');
  assert.deepEqual(g.view('h4').prompt.choices.map(c => c.action), ['save', 'skip']);
  night(g, 4, 'save', 5);
  assert.deepEqual(g.view('h4').self.potions, { save: false, poison: false });
  skipSpeech(g, advance);
  for (const p of g.players.filter(p => p.alive)) vote(g, p.seat);
  night(g, 2, 'skip');
  assert.equal(g.phase, 'speech', 'dead seer and depleted witch do not create stalled turns');
});

test('only actual mutations advance revision and shuffling is deterministic when injected', () => {
  const { game: g, advance } = table({ humans: 1, random: () => 0 });
  const before = g.revision;
  g.view('h1'); g.pendingAI(); g.tick(); g.setConnected('h1', true); g.completePlayback('none');
  assert.equal(g.revision, before);
  g.start('h1');
  assert.deepEqual(g.players.map(p => p.role), ['wolf', 'seer', 'witch', 'villager', 'villager', 'wolf']);
  const started = g.revision;
  advance(99);
  assert.equal(g.revision, started);
  advance(1);
  assert.equal(g.revision, started + 1);
});

test('timeouts never invent bot speech, kills, investigations or votes', () => {
  const { game: g, advance } = table({ humans: 2 }); g.start('h1');
  assert.equal(advance(99), false);
  assert.equal(advance(1), true); // wolves skip
  assert.equal(g.phase, 'night');
  advance(); // seer skip
  assert.deepEqual(g.view(id(g, 3)).self.clues, []);
  advance(); // witch skip
  assert.equal(g.phase, 'speech');
  assert.equal(g.players.every(p => p.alive), true);
  assert.equal(g.logs.some(l => /狼人.*跳过|预言家.*跳过|女巫.*跳过/.test(l.text)), false);
  skipSpeech(g, advance);
  assert.equal(g.speech, null);
  assert.ok(g.logs.some(l => l.text.includes('（AI）未在时限内发言')));
  advance(); // all votes abstain
  assert.equal(g.phase, 'night');
  assert.equal(g.round, 2);
  assert.equal(g.players.every(p => p.alive), true);
  assert.ok(g.logs.some(l => l.text.includes('全部弃票')));
});

test('offline players cannot stall phases and late submissions cannot cross a deadline', () => {
  const { game: g, advance } = table(); g.start('h1');
  for (const p of g.players) g.setConnected(p.id, false);
  assert.equal(g.hostId, null);
  advance(); advance(); advance();
  assert.equal(g.phase, 'speech');
  for (let n = 0; n < 6; n++) advance();
  assert.equal(g.phase, 'vote');
  advance();
  assert.equal(g.round, 2);
  g.setConnected('h1', true);
  assert.equal(g.hostId, 'h1');
  assert.equal(g.view('h1').prompt.kind, 'night');
  let now = 0;
  const late = new Game({ roomId: '0000', now: () => now, random: () => 0.999, durations: { night: 10 } });
  late.join({ id: 'human', name: '玩家' }); late.join({ id: 'other', name: '同桌' }); late.start('human');
  now = 10;
  assert.throws(() => late.act('human', { kind: 'night', action: 'kill', target: 5 }), /超时/);
  assert.equal(late.view('human').prompt, null);
});

test('playback deadline advances even when clients never acknowledge speech', () => {
  const { game: g, advance } = table(); g.start('h1'); skipNight(g);
  g.act('h1', { kind: 'speech', text: '一次公开发言' });
  const oldSpeech = g.speech.id;
  advance();
  assert.equal(g.phase, 'speech');
  assert.equal(g.speech, null);
  assert.equal(g.view('h2').prompt.kind, 'speech');
  assert.equal(g.completePlayback(oldSpeech), false);
});

test('pendingAI is exactly a private view projection and never contains raw game secrets', () => {
  const { game: g } = table();
  for (const seat of [2, 3, 4, 5]) g.leave(`h${seat}`);
  g.start('h1');
  const wolf = g.pendingAI();
  assert.deepEqual(wolf.context, g.view(wolf.playerId));
  assert.deepEqual(wolf.context.players.filter(p => p.role).map(p => p.seat), [2]);
  assert.ok(wolf.context.self.clues.some(c => c.includes('1 号')));
  assert.equal(JSON.stringify(wolf).includes('_nightActions'), false);
  wolf.context.self.clues.push('forged');
  wolf.choices.length = 0;
  assert.notDeepEqual(wolf, g.pendingAI());
  night(g, 1, 'kill', 6); night(g, 2, 'kill', 6);
  const seer = g.pendingAI();
  assert.equal(seer.playerId, id(g, 3));
  assert.deepEqual(seer.context, g.view(seer.playerId));
  assert.equal('threatenedSeat' in seer.context.self, false);
  assert.deepEqual(seer.context.self.clues, []);
  assert.equal(seer.context.players.some(p => p.role === 'wolf'), false);
  assert.equal(seer.context.players.some(p => p.role === 'witch'), false);
});

test('changing inaccessible hidden roles does not change a villager projection', () => {
  const a = table().game; const b = table().game;
  a.start('h1'); b.start('h1');
  // Same public world and self, different hidden assignment.
  [b.players[2].role, b.players[3].role] = [b.players[3].role, b.players[2].role];
  [b.players[2].potions, b.players[3].potions] = [b.players[3].potions, b.players[2].potions];
  assert.deepEqual(a.view('h5'), b.view('h5'));
});

test('public logs remain bounded after repeated legal all-pass rounds', () => {
  const { game: g, advance } = table(); g.start('h1');
  for (let round = 0; round < 25; round++) {
    skipNight(g); skipSpeech(g, advance);
    for (const p of g.players) vote(g, p.seat);
  }
  assert.equal(g.round, 26);
  assert.equal(g.logs.length, 200);
  assert.equal(new Set(g.logs.map(l => l.id)).size, 200);
  assert.equal(g.players.every(p => p.alive), true);
});
