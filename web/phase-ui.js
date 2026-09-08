const STAGES = [
  { id: 'lobby', label: '等候' },
  { id: 'night', label: '夜晚' },
  { id: 'speech', label: '发言' },
  { id: 'vote', label: '投票' },
  { id: 'result', label: '结算' },
];
const setText = (node, value) => { if (node.textContent !== String(value)) node.textContent = String(value); };
const COPY = {
  lobby: { title: '同桌已就位，故事待开场', hint: '等朋友入座，或现在开始。AI 会补齐六个席位。', transition: '已入座，等候开局' },
  night: { title: '天黑请闭眼', hint: '守好自己的秘密，等待夜晚行动完成。', transition: '夜幕降临 · 天黑请闭眼' },
  speech: { title: '天亮了，听听彼此', hint: '轮流分享判断，留意每一句话里的线索。', transition: '天亮了 · 进入白天发言' },
  vote: { title: '把你的判断，交给这一票', hint: '选择放逐对象，也可以弃票。平票时无人出局。', transition: '发言结束 · 开始放逐投票' },
  result: { title: '今夜的答案，揭晓了', hint: '所有身份已公开，可以回看记录，或和同桌再来一局。', transition: '牌局结束 · 身份揭晓' },
};

/** Derive only from the recipient's existing private view, never a raw Game. */
export function derivePhasePresentation(view, { connected = true, pending = false, submitted = false, now = Date.now() } = {}) {
  if (!view) return null;
  const stage = view.phase === 'playback' ? 'speech' : STAGES.some((item) => item.id === view.phase) ? view.phase : 'lobby';
  const copy = COPY[stage];
  const player = (view.players || []).find((item) => item.id === view.selfId);
  const observing = !['lobby', 'result'].includes(stage) && player?.alive === false;
  const ownPrompt = connected && !observing && Boolean(view.prompt);
  const myTurn = ownPrompt && !pending;
  // A night deadline is a private role substage, not the remaining whole night.
  // Non-acting clients must not derive progression from those deadline resets.
  const showDeadline = connected && !['lobby', 'result'].includes(stage) && (stage !== 'night' || ownPrompt) && Number.isFinite(view.deadline);
  const seconds = showDeadline ? Math.max(0, Math.ceil((view.deadline - now) / 1000)) : null;
  const urgency = myTurn && seconds !== null ? seconds === 0 ? 'expired' : seconds <= 10 ? 'urgent' : seconds <= 20 ? 'soon' : 'normal' : 'normal';
  let mode = 'waiting';
  let status = '等候同桌';
  let instruction = copy.hint;
  if (!connected) {
    mode = 'offline'; status = '连接中断 · 进度待同步'; instruction = '重新连接后按最新提示继续。当前页面不再倒计时。';
  } else if (pending) {
    mode = 'pending'; status = '正在提交，请稍候'; instruction = '正在等待服务器确认，请勿重复操作。';
  } else if (observing) {
    mode = 'observer'; status = '你已出局 · 旁观中'; instruction = '继续阅读同桌发言，看看你的推理是否正确。';
  } else if (myTurn) {
    mode = 'turn'; status = '轮到你了';
    instruction = stage === 'night' ? '完成下方的私密行动，只有你能看到自己的选项。' : stage === 'vote' ? '在下方选择一位玩家，确认后投票；也可以弃票。' : '在下方准备发言，核对文字后发送给同桌。';
    if (urgency === 'expired') instruction = '行动时间已到，正在等待服务器推进。';
    else if (urgency === 'urgent') instruction = '即将超时，请尽快完成下方操作。';
  } else if (stage === 'result') {
    mode = 'complete'; status = view.canRestart ? '你可以发起下一局' : '等待同桌开启下一局';
  } else if (stage === 'lobby') {
    mode = view.canStart ? 'ready' : 'waiting'; status = view.canStart ? '每位在线玩家都可以开局' : '等待连接后开局';
  } else if (submitted || stage === 'vote' && player?.alive) {
    mode = 'submitted'; status = stage === 'vote' ? '投票已提交 · 等待同桌' : stage === 'speech' ? '发言已提交 · 等待同桌' : '行动已提交 · 等待夜晚结束';
    instruction = stage === 'night' ? '本轮无需再次操作，天亮后继续推理。' : stage === 'vote' ? '全桌完成后会公布票型，请稍候。' : '你的发言已进入公开记录，继续听听其他人的判断。';
  } else if (stage === 'night') {
    status = '等待夜晚结束';
  } else if (view.phase === 'playback' && view.speech) {
    status = `${view.speech.seat} 号正在发言`; instruction = '阅读当前发言和公开记录，轮到你时会在这里提醒。';
  } else {
    status = '等待同桌发言';
  }
  const winnerTitle = view.result?.winner === 'wolves' ? '狼人阵营获胜' : view.result?.winner === 'villagers' ? '好人阵营获胜' : null;
  return {
    stage, key: `${view.roomId}:${view.round || 0}:${stage}`, round: view.round || 0,
    title: stage === 'result' && winnerTitle ? winnerTitle : copy.title,
    eyebrow: stage === 'lobby' ? '今夜的序章' : stage === 'result' ? '终局 · 身份揭晓' : `第 ${view.round || 1} ${stage === 'night' ? '夜' : '天'} · ${STAGES.find((item) => item.id === stage).label}阶段`,
    hint: copy.hint, transition: copy.transition, mode, status, instruction, myTurn, observing,
    seconds, urgency, timerLabel: !connected ? '进度待同步' : seconds === null ? stage === 'night' ? '请等待天亮' : '' : ownPrompt ? '你的行动剩余' : '当前环节剩余',
    steps: STAGES.map((item, index) => ({ ...item, number: index + 1, state: item.id === stage ? 'current' : index < STAGES.findIndex((step) => step.id === stage) ? 'done' : 'upcoming' })),
  };
}

/** Pure lifecycle decisions; DOM animation and audio are deliberately separate. */
export class PhaseTracker {
  constructor() { this.reset(); }
  reset() { this.key = null; this.hidden = false; this.submitted = false; this.attempt = null; this.view = null; }
  setHidden(hidden) { this.hidden = Boolean(hidden); }
  markSubmitted() { if (this.view?.prompt) this.attempt = { key: this.key, revision: this.view.revision }; }
  clearSubmission() { this.attempt = null; this.submitted = false; }
  update(view, options = {}) {
    const initial = derivePhasePresentation(view, options);
    if (!initial) return { presentation: null, transition: false };
    const changed = this.key !== initial.key;
    if (changed) { this.submitted = false; this.attempt = null; }
    else if (this.attempt && view.revision > this.attempt.revision && !view.prompt) { this.submitted = true; this.attempt = null; }
    this.key = initial.key;
    this.view = view;
    return { presentation: derivePhasePresentation(view, { ...options, submitted: this.submitted }), transition: changed && !this.hidden };
  }
}

export class PhaseUI {
  constructor({ root = document, setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = (id) => globalThis.clearTimeout(id) } = {}) {
    this.root = root; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.tracker = new PhaseTracker(); this.view = null; this.options = {}; this.presentation = null;
    this.dom = Object.fromEntries(['phaseGuide', 'phaseEyebrow', 'phaseTitle', 'phaseHint', 'phaseSteps', 'phaseTaskStatus', 'phaseTaskHint', 'phaseActionJump', 'phaseClockLabel', 'phaseClockValue', 'phaseTransition', 'phaseTransitionText', 'gameView', 'actionPanel', 'actionTag'].map((id) => [id, root.getElementById(id)]));
    this.dom.phaseActionJump.addEventListener('click', () => {
      const reduce = root.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.dom.actionPanel.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      this.dom.actionPanel.focus({ preventScroll: true });
    });
    this.reset();
  }
  update(view, options = {}) {
    this.view = view; this.options = options;
    const update = this.tracker.update(view, options);
    this.presentation = update.presentation;
    this.render(update.transition);
    return this.presentation;
  }
  tick(now = Date.now()) {
    if (!this.view || this.tracker.hidden) return;
    this.presentation = derivePhasePresentation(this.view, { ...this.options, submitted: this.tracker.submitted, now });
    this.render(false);
  }
  markSubmitted() { this.tracker.markSubmitted(); }
  clearSubmission() { this.tracker.clearSubmission(); }
  setHidden(hidden) {
    this.tracker.setHidden(hidden);
    this.dom.gameView.classList.toggle('phase-motion-paused', Boolean(hidden));
    if (hidden) this.stopTransition();
  }
  stopTransition() {
    this.clearTimer(this.timer);
    this.dom.phaseTransition.hidden = true;
    this.dom.phaseGuide.classList.remove('phase-enter');
  }
  reset() {
    this.stopTransition(); this.tracker.reset(); this.view = null; this.presentation = null;
    this.dom.phaseGuide.hidden = true;
    this.dom.gameView.classList.remove('phase-motion-paused');
    this.dom.actionPanel.classList.remove('is-your-turn', 'is-submitted', 'is-observing', 'is-urgent');
  }
  render(transition) {
    const value = this.presentation;
    if (!value) return;
    const d = this.dom;
    d.phaseGuide.hidden = false;
    d.phaseGuide.dataset.stage = value.stage;
    d.phaseGuide.dataset.mode = value.mode;
    d.phaseGuide.dataset.urgency = value.urgency;
    setText(d.phaseEyebrow, value.eyebrow);
    setText(d.phaseTitle, value.title);
    setText(d.phaseHint, value.hint);
    setText(d.phaseTaskStatus, value.status);
    setText(d.phaseTaskHint, value.instruction);
    d.phaseActionJump.hidden = !['turn', 'ready', 'complete'].includes(value.mode) || value.mode === 'complete' && !this.view.canRestart;
    setText(d.phaseActionJump, value.mode === 'ready' ? '去开局 ↓' : value.mode === 'complete' ? '再来一局 ↓' : '去操作 ↓');
    setText(d.phaseClockLabel, value.timerLabel);
    setText(d.phaseClockValue, value.seconds === null ? '' : `${value.seconds}`);
    d.phaseClockValue.setAttribute('aria-label', value.seconds === null ? value.timerLabel : `${value.timerLabel} ${value.seconds} 秒`);
    const changedSteps = d.phaseSteps.dataset.stage !== value.stage;
    if (changedSteps) {
      d.phaseSteps.dataset.stage = value.stage;
      d.phaseSteps.replaceChildren(...value.steps.map((step) => {
        const li = this.root.createElement('li'); li.className = `phase-step ${step.state}`;
        const number = this.root.createElement('span'); number.className = 'phase-step-number'; number.textContent = String(step.number).padStart(2, '0');
        const label = this.root.createElement('span'); label.textContent = step.label;
        if (step.state === 'current') li.setAttribute('aria-current', 'step');
        li.append(number, label); return li;
      }));
    }
    d.actionPanel.classList.toggle('is-your-turn', value.mode === 'turn');
    d.actionPanel.classList.toggle('is-submitted', value.mode === 'submitted' || value.mode === 'pending');
    d.actionPanel.classList.toggle('is-observing', value.mode === 'observer');
    d.actionPanel.classList.toggle('is-urgent', value.urgency === 'urgent' || value.urgency === 'expired');
    setText(d.actionTag, value.mode === 'turn' ? value.urgency === 'urgent' ? '请尽快操作' : '轮到你了' : value.mode === 'pending' ? '提交中' : value.mode === 'submitted' ? '已提交' : value.mode === 'observer' ? '已出局 · 旁观' : value.mode === 'offline' ? '进度待同步' : this.view.canStart ? '随时开局' : '');
    if (transition) {
      this.stopTransition();
      d.phaseTransitionText.textContent = value.transition;
      d.phaseTransition.hidden = false;
      void d.phaseGuide.offsetWidth;
      d.phaseGuide.classList.add('phase-enter');
      this.timer = this.setTimer(() => this.stopTransition(), 3400);
    }
  }
}
