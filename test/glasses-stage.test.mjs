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
