import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePhasePresentation, PhaseTracker } from '../web/phase-ui.js';

const view = (phase, extra = {}) => ({ roomId: '0037', round: 1, revision: 1, phase, deadline: 80000, selfId: 'me', selfSeat: 1, players: [{ id: 'me', seat: 1, alive: true }, { id: 'other', seat: 2, alive: true }], prompt: null, ...extra });
test('night waiting never exposes role substage timing or actor hints', () => {
  const first = derivePhasePresentation(view('night'), { now: 1000 });
  const otherSubstage = derivePhasePresentation(view('night', { deadline: 200000, phaseLabel: '预言家行动', aiStatus: '2号狼正在行动', privateActor: 'other' }), { now: 9999 });
  assert.deepEqual(first, otherSubstage);
  assert.equal(first.seconds, null);
  assert.equal(first.status, '等待夜晚结束');
  assert.equal(first.mode, 'waiting');
});
test('only the recipient prompt lights up their private turn and deadline', () => {
  const value = derivePhasePresentation(view('night', { prompt: { kind: 'night' } }), { now: 1000 });
  assert.equal(value.mode, 'turn');
  assert.equal(value.seconds, 79);
  assert.match(value.instruction, /只有你/);
});
test('speech and playback use one major daytime stage and progress step', () => {
  const a = derivePhasePresentation(view('speech'));
  const b = derivePhasePresentation(view('playback', { speech: { seat: 2, name: '同桌', text: '游戏发言' } }));
  assert.equal(a.key, b.key);
  assert.equal(b.steps.filter(s => s.state === 'current')[0].id, 'speech');
  assert.equal(b.status, '2 号正在发言');
  assert.doesNotMatch(b.status + b.instruction, /朗读|声音|播放成功/);
});
test('dead players are clearly observing even if a stale prompt remains', () => {
  const v = view('vote', { players: [{ id: 'me', alive: false }], prompt: { kind: 'vote' } });
  const model = derivePhasePresentation(v, { now: 79000 });
  assert.equal(model.mode, 'observer');
  assert.equal(model.myTurn, false);
  assert.equal(model.urgency, 'normal');
});
test('disconnected views stop stale countdowns and never claim the whole room paused', () => {
  const value = derivePhasePresentation(view('night', { prompt: { kind: 'night' } }), { connected: false, now: 79999 });
  assert.equal(value.seconds, null);
  assert.equal(value.mode, 'offline');
  assert.equal(value.myTurn, false);
  assert.match(value.status, /进度待同步/);
  assert.doesNotMatch(value.instruction, /整桌暂停|大家暂停/);
});
test('urgent countdown is limited to actionable own turns, and expires without claiming completion', () => {
  const v = view('vote', { prompt: { kind: 'vote' } });
  assert.equal(derivePhasePresentation(v, { now: 60000 }).urgency, 'soon');
  assert.equal(derivePhasePresentation(v, { now: 71000 }).urgency, 'urgent');
  const expired = derivePhasePresentation(v, { now: 81000 });
  assert.equal(expired.seconds, 0);
  assert.equal(expired.urgency, 'expired');
  assert.match(expired.instruction, /等待服务器/);
  assert.equal(derivePhasePresentation(view('vote'), { now: 79999 }).urgency, 'normal');
});
test('server-confirmed vote completion is distinguishable from submitting and night waiting', () => {
  assert.equal(derivePhasePresentation(view('vote')).mode, 'submitted');
  assert.equal(derivePhasePresentation(view('night')).mode, 'waiting');
  assert.equal(derivePhasePresentation(view('vote', { prompt: { kind: 'vote' } }), { pending: true }).mode, 'pending');
});
test('revision updates and every speaker playback do not replay the daytime transition', () => {
  const tracker = new PhaseTracker();
  assert.equal(tracker.update(view('speech')).transition, true);
  for (let i = 2; i < 15; i++) {
    assert.equal(tracker.update(view(i % 2 ? 'speech' : 'playback', { revision: i })).transition, false);
  }
  assert.equal(tracker.update(view('vote', { revision: 15 })).transition, true);
  assert.equal(tracker.update(view('night', { round: 2, revision: 16 })).transition, true);
});
test('an attempted night action is not called submitted until the server removes its prompt', () => {
  const tracker = new PhaseTracker();
  const start = view('night', { prompt: { kind: 'night' } });
  tracker.update(start); tracker.markSubmitted();
  assert.equal(tracker.update(start, { pending: true }).presentation.mode, 'pending');
  assert.equal(tracker.update({ ...start, revision: 2 }).presentation.mode, 'turn');
  assert.equal(tracker.update({ ...start, revision: 3, prompt: null }).presentation.mode, 'submitted');
  assert.equal(tracker.update(view('night', { round: 2, revision: 4 })).presentation.mode, 'waiting');
});
test('rejected actions clear submission attempts instead of pretending success later', () => {
  const tracker = new PhaseTracker();
  tracker.update(view('night', { prompt: { kind: 'night' } })); tracker.markSubmitted(); tracker.clearSubmission();
  assert.equal(tracker.update(view('night', { revision: 2 })).presentation.mode, 'waiting');
});
test('hidden updates consume phase changes without animation replay on return, reset starts fresh', () => {
  const tracker = new PhaseTracker();
  tracker.update(view('night')); tracker.setHidden(true);
  assert.equal(tracker.update(view('speech')).transition, false);
  tracker.setHidden(false);
  assert.equal(tracker.update(view('playback', { revision: 2 })).transition, false);
  tracker.reset();
  assert.equal(tracker.update(view('lobby', { round: 0 })).transition, true);
});
test('result uses the public result only and marks the final progress step', () => {
  const value = derivePhasePresentation(view('result', { deadline: null, result: { winner: 'villagers' }, canRestart: true }));
  assert.equal(value.title, '好人阵营获胜');
  assert.equal(value.seconds, null);
  assert.equal(value.steps.at(-1).state, 'current');
  assert.equal(value.mode, 'complete');
});
