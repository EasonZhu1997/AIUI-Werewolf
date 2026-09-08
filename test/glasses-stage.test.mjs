import test from 'node:test';
import assert from 'node:assert/strict';
import { glassesStage, glassesCountdown } from '../lib/glasses-stage.js';

const view = extra => ({ phase: 'night', round: 2, selfId: 'me', players: [{ id: 'me', seat: 1, alive: true }], prompt: null, ...extra });

test('waiting night presentation does not reveal private substeps through status or timer resets', () => {
  const first = view({ deadline: 1000, aiStatus: 'hidden one' });
  const second = view({ deadline: 5000, aiStatus: 'hidden two' });
  assert.deepEqual(glassesStage(first), glassesStage(second));
  assert.deepEqual(glassesCountdown(first, { now: 100 }), glassesCountdown(second, { now: 100 }));
  assert.equal(glassesCountdown(first).timeLabel, '等待夜晚结束');
  assert.equal(glassesStage(first).roundLabel, '第 2 夜');
});

test('own prompt gets actionable countdown while dead players remain spectators', () => {
  const action = view({ deadline: 10000, prompt: { kind: 'night' } });
  assert.equal(glassesStage(action).stageBadge, '轮到你');
  assert.deepEqual(glassesCountdown(action, { now: 1000 }), { timeLabel: '9 秒', clockUrgent: true });
  assert.equal(glassesStage(view({ players: [{ id: 'me', alive: false }] })).stageBadge, '旁观');
});

test('solo peaceful first night explains waiting without marking a living player eliminated', () => {
  const firstNight = view({ round: 1, rules: { peacefulFirstNight: true } });
  const stage = glassesStage(firstNight);
  assert.equal(stage.stageName, '单人练习 · 首夜平安');
  assert.equal(stage.stageHint, '首夜只进行预言家查验，天亮后所有人进入发言。');
  assert.equal(stage.stageMode, 'waiting');
  assert.equal(stage.ownTurn, false);
  assert.equal(glassesCountdown(firstNight).timeLabel, '等待夜晚结束');
});

test('peaceful first night retains the seer action and does not override offline or death state', () => {
  const firstNight = view({ round: 1, rules: { peacefulFirstNight: true }, prompt: { kind: 'night' } });
  assert.equal(glassesStage(firstNight).stageBadge, '轮到你');
  assert.equal(glassesStage(firstNight).stageHint, '首夜只进行预言家查验，天亮后所有人进入发言。');
  assert.equal(glassesStage(firstNight, { connected: false }).stageMode, 'offline');
  assert.equal(glassesStage({ ...firstNight, players: [{ id: 'me', alive: false }] }).stageMode, 'spectating');
});

test('peaceful first-night copy requires the rule and expires at dawn or the second night', () => {
  for (const v of [view({ round: 1 }), view({ round: 1, rules: { peacefulFirstNight: false } }), view({ rules: { peacefulFirstNight: true } }), view({ phase: 'speech', round: 1, rules: { peacefulFirstNight: true } })]) {
    assert.doesNotMatch(JSON.stringify(glassesStage(v)), /首夜平安|首夜只进行/);
  }
});

test('public playback labels speech content without claiming audible output', () => {
  const playback = view({ phase: 'playback', speech: { seat: 3 } });
  assert.match(glassesStage(playback, { muted: true }).stageHint, /本机已静音/);
  assert.doesNotMatch(glassesStage(playback).stageHint, /正在出声|已经听到/);
  assert.equal(glassesStage(playback).stageIndex, glassesStage(view({ phase: 'speech' })).stageIndex);
});

test('connection loss hides stage progression and never claims the whole table paused', () => {
  const offline = glassesStage(view({ phase: 'vote', deadline: 10000 }), { connected: false });
  assert.equal(offline.stageMode, 'offline'); assert.equal(offline.stageSteps.some(s => s.active), false);
  assert.doesNotMatch(offline.stageHint, /全桌暂停|所有玩家/);
  assert.equal(glassesCountdown(view({ deadline: 10000 }), { connected: false }).timeLabel, '未同步');
});

test('result clearly identifies the winning side from public result only', () => {
  assert.equal(glassesStage(view({ phase: 'result', result: { winner: 'wolves' } })).stageHint, '狼人阵营获胜');
  assert.equal(glassesStage(view({ phase: 'result', result: { winner: 'villagers' } })).stageHint, '好人阵营获胜');
});

test('lobby instructions allow any connected player to start without a host requirement', () => {
  const stage = glassesStage(view({ phase: 'lobby', hostId: 'someone-else', canStart: true }));
  assert.equal(stage.stageBadge, '可开局'); assert.match(stage.stageHint, /任意一人/); assert.doesNotMatch(stage.stageHint, /房主/);
});
