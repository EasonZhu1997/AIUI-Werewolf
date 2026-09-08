import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game.mjs';

function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function table({ seed = 1, humans = 1, random = seededRandom(seed) } = {}) {
  let now = 1000;
  const game = new Game({ roomId: '7314', random, now: () => now, durations: { night: 10, speech: 10, playback: 10, vote: 10 } });
  for (let seat = 1; seat <= humans; seat++) game.join({ id: `h${seat}`, name: `玩家${seat}` });
  return { game, expire() { now += 10; return game.tick(); } };
}

const playerWithRole = (game, role) => game.players.find(player => player.role === role);
const night = (game, player, action, target = null) => game.act(player.id, { kind: 'night', action, target });
const aliveSeats = game => game.players.filter(player => player.alive).map(player => player.seat);

function skipNight(game) {
  for (let remaining = 6; game.phase === 'night'; remaining--) {
    assert.ok(remaining > 0, 'night must finish after its pending actors act');
    const player = game.players.find(item => game.view(item.id).prompt?.kind === 'night');
    assert.ok(player, 'each unfinished night has a legal action');
    night(game, player, 'skip');
  }
}

function speakDay(game) {
  const speakers = [];
  for (let remaining = 6; game.phase === 'speech'; remaining--) {
    assert.ok(remaining > 0, 'a day has at most six speakers');
    const player = game.players.find(item => game.view(item.id).prompt?.kind === 'speech');
    assert.ok(player, 'each speech turn has a living speaker');
    speakers.push(player.id);
    game.act(player.id, { kind: 'speech', text: '我先听大家的解释，再决定投票。' });
    assert.equal(game.phase, 'playback');
    assert.equal(game.completePlayback(game.speech.id), true);
  }
  assert.equal(game.phase, 'vote');
  return speakers;
}

function voteDay(game, target = null) {
  for (const player of game.players.filter(item => item.alive)) {
    const seat = target === player.seat ? null : target;
    game.act(player.id, { kind: 'vote', action: seat === null ? 'skip' : 'vote', target: seat });
  }
}

function finishByExilingWolves(game) {
  for (let remaining = 2; game.phase !== 'result'; remaining--) {
    assert.ok(remaining > 0);
    skipNight(game);
    speakDay(game);
    voteDay(game, game.players.find(player => player.alive && player.role === 'wolf').seat);
  }
  assert.equal(game.result.winner, 'villagers');
}

test('seed 1 regression: the lone villager cannot be killed or poisoned before their first speech', () => {
  const { game } = table();
  game.start('h1');
  assert.deepEqual(game.players.map(player => player.role), ['villager', 'wolf', 'witch', 'seer', 'villager', 'wolf']);
  assert.deepEqual(game.view('h1').rules, { peacefulFirstNight: true });
  const actors = game.players.filter(player => game.view(player.id).prompt);
  assert.deepEqual(actors.map(player => player.role), ['seer']);
  for (const wolf of game.players.filter(player => player.role === 'wolf')) {
    assert.throws(() => night(game, wolf, 'kill', 1), /回合/);
  }
  const witch = playerWithRole(game, 'witch');
  assert.throws(() => night(game, witch, 'poison', 1), /回合/);
  assert.throws(() => night(game, witch, 'save', 1), /回合/);
  night(game, playerWithRole(game, 'seer'), 'skip');
  assert.deepEqual(aliveSeats(game), [1, 2, 3, 4, 5, 6]);
  assert.equal(game.result, null);
  assert.equal(game.view('h1').prompt.kind, 'speech');
  assert.deepEqual(game.view(witch.id).self.potions, { save: true, poison: true });
});

for (const [role, seed] of Object.entries({ villager: 1, witch: 2, seer: 11, wolf: 23 })) {
  test(`a lone ${role} gets a first-day speech and all AI speakers after a peaceful opening`, () => {
    const { game } = table({ seed });
    game.start('h1');
    assert.equal(game.view('h1').self.role, role);
    const witch = playerWithRole(game, 'witch');
    skipNight(game);
    assert.deepEqual(aliveSeats(game), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(game.view(witch.id).self.potions, { save: true, poison: true });
    const speakers = speakDay(game);
    assert.equal(speakers.length, 6);
    assert.equal(speakers.filter(id => id === 'h1').length, 1);
    assert.equal(game.result, null);
  });
}

test('solo opening protection follows the human at a later seat, not seat 1', () => {
  const { game } = table({ humans: 4 });
  for (const id of ['h1', 'h2', 'h3']) game.leave(id);
  game.start('h4');
  assert.equal(game.view('h4').selfSeat, 4);
  assert.equal(game.view('h4').rules.peacefulFirstNight, true);
  skipNight(game);
  assert.deepEqual(aliveSeats(game), [1, 2, 3, 4, 5, 6]);
  assert.ok(speakDay(game).includes('h4'));
});

test('a lone seer can inspect on the first night without exposing the result to other players', () => {
  const { game } = table({ seed: 11 });
  game.start('h1');
  const wolf = playerWithRole(game, 'wolf');
  const seer = playerWithRole(game, 'seer');
  assert.equal(seer.id, 'h1');
  night(game, seer, 'inspect', wolf.seat);
  const clue = game.view('h1').self.clues[0];
  assert.match(clue, new RegExp(`查验 ${wolf.seat} 号`));
  assert.match(clue, /狼人阵营/);
  for (const other of game.players.filter(player => player.id !== 'h1')) {
    assert.equal(JSON.stringify(game.view(other.id)).includes(clue), false);
  }
  assert.equal(game.view('h1').prompt.kind, 'speech');
  assert.deepEqual(aliveSeats(game), [1, 2, 3, 4, 5, 6]);
});

test('a lone seer timing out still reaches a peaceful dawn without inventing a clue', () => {
  const { game, expire } = table({ seed: 11 });
  game.start('h1');
  assert.equal(expire(), true);
  assert.equal(game.phase, 'speech');
  assert.deepEqual(game.view('h1').self.clues, []);
  assert.deepEqual(aliveSeats(game), [1, 2, 3, 4, 5, 6]);
});

test('the first day can still legally exile the sole human after they have spoken', () => {
  const { game } = table();
  game.start('h1');
  skipNight(game);
  assert.ok(speakDay(game).includes('h1'));
  voteDay(game, 1);
  assert.equal(game.view('h1').players.find(player => player.id === 'h1').alive, false);
  assert.equal(game.round, 2);
});

test('the second night restores wolf attacks and witch poison, including killing the human', () => {
  const { game } = table();
  game.start('h1');
  skipNight(game);
  speakDay(game);
  voteDay(game);
  assert.equal(game.round, 2);
  for (const wolf of game.players.filter(player => player.role === 'wolf')) night(game, wolf, 'kill', 1);
  night(game, playerWithRole(game, 'seer'), 'skip');
  const witch = playerWithRole(game, 'witch');
  assert.equal(game.view(witch.id).self.potions.threatenedSeat, 1);
  night(game, witch, 'poison', 4);
  assert.deepEqual(aliveSeats(game), [2, 3, 5, 6]);
  assert.equal(game.phase, 'result');
  assert.equal(game.result.winner, 'wolves');
  assert.deepEqual(game.view(witch.id).self.potions, { save: true, poison: false });
});

test('a multiplayer first night retains legal deaths and an immediate parity win', () => {
  const { game } = table({ humans: 2 });
  game.start('h1');
  assert.equal(game.view('h1').rules.peacefulFirstNight, false);
  for (const wolf of game.players.filter(player => player.role === 'wolf')) night(game, wolf, 'kill', 1);
  night(game, playerWithRole(game, 'seer'), 'skip');
  night(game, playerWithRole(game, 'witch'), 'poison', 4);
  assert.deepEqual(aliveSeats(game), [2, 3, 5, 6]);
  assert.equal(game.result.winner, 'wolves');
});

test('a multiplayer game cannot become protected when all but one human disconnect', () => {
  const { game, expire } = table({ humans: 2 });
  game.start('h1');
  game.setConnected('h2', false);
  assert.equal(game.view('h1').rules.peacefulFirstNight, false);
  const connectedWolf = game.players.find(player => player.role === 'wolf' && player.connected);
  night(game, connectedWolf, 'kill', 1);
  assert.equal(expire(), true); // The disconnected wolf abstains; the existing attack remains legal.
  night(game, playerWithRole(game, 'seer'), 'skip');
  night(game, playerWithRole(game, 'witch'), 'skip');
  assert.equal(game.view('h1').players.find(player => player.id === 'h1').alive, false);
  game.setConnected('h2', true);
  assert.equal(game.view('h2').rules.peacefulFirstNight, false);
});

test('solo reconnect preserves the opening rule, while a restarted deal uses its new human count', () => {
  const { game } = table();
  game.start('h1');
  game.setConnected('h1', false);
  assert.equal(game.view('h1').rules.peacefulFirstNight, true);
  game.setConnected('h1', true);
  assert.equal(game.view('h1').rules.peacefulFirstNight, true);
  finishByExilingWolves(game);
  game.restart('h1');
  assert.equal(game.view('h1').rules.peacefulFirstNight, false);
  game.join({ id: 'friend', name: '朋友' });
  game.start('friend');
  assert.equal(game.view('h1').rules.peacefulFirstNight, false);
  finishByExilingWolves(game);
  game.setConnected('friend', false);
  game.restart('h1');
  game.start('h1');
  assert.equal(game.view('h1').rules.peacefulFirstNight, true);
});

test('offline lobby seats do not prevent solo protection and views cannot mutate its rule', () => {
  const { game } = table({ humans: 2 });
  game.setConnected('h2', false);
  game.start('h1');
  assert.equal(game.players.filter(player => !player.bot).length, 1);
  const view = game.view('h1');
  assert.equal(view.rules.peacefulFirstNight, true);
  view.rules.peacefulFirstNight = false;
  assert.equal(game.view('h1').rules.peacefulFirstNight, true);
  skipNight(game);
  assert.deepEqual(aliveSeats(game), [1, 2, 3, 4, 5, 6]);
});

for (const [sample, expectedVictim] of [[0, 5], [1 - Number.EPSILON, 6]]) {
  test(`a tied wolf ballot can select seat ${expectedVictim} with random sample ${sample}`, () => {
    let calls = 0;
    const { game } = table({ humans: 2, random: () => ++calls <= 5 ? 0.999 : sample });
    game.start('h1');
    night(game, game.players[0], 'kill', 6);
    night(game, game.players[1], 'kill', 5);
    night(game, playerWithRole(game, 'seer'), 'skip');
    const witch = playerWithRole(game, 'witch');
    assert.equal(game.view(witch.id).self.potions.threatenedSeat, expectedVictim);
    assert.equal(calls, 6);
    night(game, witch, 'skip');
    assert.equal(game.players.find(player => player.seat === expectedVictim).alive, false);
    assert.equal(game.players.find(player => player.seat === (expectedVictim === 5 ? 6 : 5)).alive, true);
  });
}

test('unanimous and empty wolf ballots do not draw a random tiebreaker', () => {
  for (const target of [5, null]) {
    let calls = 0;
    const { game } = table({ humans: 2, random: () => { calls++; return 0.999; } });
    game.start('h1');
    for (const wolf of game.players.filter(player => player.role === 'wolf')) night(game, wolf, target === null ? 'skip' : 'kill', target);
    night(game, playerWithRole(game, 'seer'), 'skip');
    const witchView = game.view(playerWithRole(game, 'witch').id);
    assert.equal(witchView.self.potions.threatenedSeat, target);
    assert.equal(calls, 5);
  }
});

test('wolf ballot tiebreakers reject invalid injected random samples', () => {
  for (const sample of [-0.1, 1, NaN, Infinity]) {
    let calls = 0;
    const { game } = table({ humans: 2, random: () => ++calls <= 5 ? 0.999 : sample });
    game.start('h1');
    night(game, game.players[0], 'kill', 5);
    assert.throws(() => night(game, game.players[1], 'kill', 6), /随机数/);
  }
});
