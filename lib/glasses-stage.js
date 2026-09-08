const STEPS = ['等候', '夜晚', '发言', '投票', '结算'];
const indexOfPhase = { lobby: 0, night: 1, speech: 2, playback: 2, vote: 3, result: 4 };

// Only the recipient's projected view is accepted here. Never infer a private
// night role from AI status text, deadline changes, or another player's seat.
export function glassesStage(view, { connected = true, listening = false, transcript = '', muted = false } = {}) {
  const phase = view && view.phase;
  const peacefulFirstNight = view && view.rules && view.rules.peacefulFirstNight && view.round === 1 && phase === 'night';
  const peacefulHint = '首夜只进行预言家查验，天亮后所有人进入发言。';
  const index = connected && view ? indexOfPhase[phase] : -1;
  const own = view && (view.players || []).find(player => player.id === view.selfId);
  const prompt = connected && view && view.prompt;
  let label = '正在连接', badge = '未同步', hint = '连接后显示最新阶段', mode = 'offline';
  if (connected && view) {
    label = { lobby: '等候入座', night: '夜晚行动', speech: '白天发言', playback: '白天发言', vote: '放逐投票', result: '本局结算' }[phase] || '等待同步';
    if (peacefulFirstNight) label = '单人练习 · 首夜平安';
    mode = 'waiting'; badge = '等待';
    if (phase === 'lobby') {
      badge = view.canStart ? '可开局' : '等候中'; mode = view.canStart ? 'action' : 'waiting';
      hint = view.canStart ? '任意一人可开局 · AI 自动补位' : '等待状态同步 · 可与小月聊聊';
    } else if (phase === 'result') {
      badge = '已结束'; mode = 'result';
      hint = view.result && view.result.winner === 'wolves' ? '狼人阵营获胜' : view.result && view.result.winner === 'villagers' ? '好人阵营获胜' : '本局结束 · 查看结算';
    } else if (own && !own.alive) {
      badge = '旁观'; mode = 'spectating'; hint = '你已出局 · 可听发言、看记录';
    } else if (prompt) {
      badge = '轮到你'; mode = 'action';
      hint = prompt.kind === 'speech' ? listening ? '正在收音 · 说完停止并核对' : transcript ? '草稿未发送 · 核对后确认' : '主动开麦 · 核对文字后发送' : prompt.kind === 'vote' ? '左右选人或弃票 · 镜腿确认' : peacefulFirstNight ? peacefulHint : '按自己的夜间提示操作';
    } else if (phase === 'night') hint = peacefulFirstNight ? peacefulHint : '等待夜晚结束 · 暂无需操作';
    else if (phase === 'vote') hint = '等待其他玩家完成投票';
    else if (phase === 'playback' && view.speech) {
      badge = '听发言';
      hint = view.speech.seat + ' 号公开发言 · ' + (muted ? '本机已静音' : '可左右翻页');
    } else hint = '等待下一位玩家发言';
  }
  return {
    stageName: label, stageBadge: badge, stageHint: hint, stageMode: mode,
    stageSteps: STEPS.map((name, step) => ({ id: name, name, active: step === index, past: index >= 0 && step < index })),
    stageIndex: index, ownTurn: mode === 'action',
    roundLabel: !connected || !view ? '等待同步' : phase === 'lobby' ? '六人同桌' : '第 ' + view.round + (phase === 'night' ? ' 夜' : phase === 'result' ? ' 轮' : ' 天'),
    // speech / playback are one large phase; only a new own turn adds emphasis.
    transitionKey: !connected || !view ? 'offline' : view.round + ':' + index + ':' + (mode === 'action' ? 'own:' + (prompt ? prompt.kind : 'start') : mode === 'spectating' ? 'spectating' : 'shared')
  };
}

export function glassesCountdown(view, { connected = true, now = Date.now() } = {}) {
  if (!connected || !view) return { timeLabel: '未同步', clockUrgent: false };
  // The engine's night deadline belongs to a private role sub-step. Showing it
  // to waiting players would reveal sub-step transitions through timer resets.
  if (view.phase === 'night' && !view.prompt) return { timeLabel: '等待夜晚结束', clockUrgent: false };
  if (!view.deadline || view.phase === 'lobby' || view.phase === 'result') return { timeLabel: '', clockUrgent: false };
  const seconds = Math.max(0, Math.ceil((view.deadline - now) / 1000));
  return { timeLabel: seconds ? seconds + ' 秒' : '等待同步', clockUrgent: seconds > 0 && seconds <= 10 && !!view.prompt };
}
