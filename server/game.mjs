const ROLES = ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'];
const ROLE_NAMES = { wolf: '狼人', seer: '预言家', witch: '女巫', villager: '村民' };
const BOT_NAMES = ['阿岚', '栗子', '北辰', '小满', '听风', '南星'];
const LABELS = { lobby: '等待入座', night: '夜晚行动', speech: '依次发言', playback: '正在发言', vote: '放逐投票', result: '本局结束' };
const DEFAULT_DURATIONS = { night: 120_000, speech: 65_000, playback: 90_000, vote: 90_000 };
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const cleanName = value => typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 24).join('') : '';

/** Authoritative six-seat game. Only view() / pendingAI() may leave the server. */
export class Game {
  constructor({ roomId, random = Math.random, now = Date.now, durations = {} } = {}) {
    if (typeof roomId !== 'string' || !/^(?:\d{4}|lobby)$/.test(roomId)) fail('房间号须为四位数字或 lobby');
    if (typeof random !== 'function' || typeof now !== 'function') fail('无效的时钟或随机数生成器');
    this.roomId = roomId;
    this.random = random;
    this.now = now;
    this.durations = { ...DEFAULT_DURATIONS };
    for (const kind of Object.keys(DEFAULT_DURATIONS)) {
      if (durations[kind] !== undefined) {
        if (!Number.isFinite(durations[kind]) || durations[kind] < 1) fail('行动时限须为正数');
        this.durations[kind] = durations[kind];
      }
    }
    this.revision = 0;
    this.phase = 'lobby';
    this.deadline = null;
    this.players = [];
    this.hostId = null;
    this.round = 0;
    this.speech = null;
    this.result = null;
    this.story = { messages: [] };
    this._peacefulFirstNight = false;
    this.logs = [];
    this._sequence = 0;
    this._botSequence = 0;
    this._nightStage = null;
    this._nightActions = new Map();
    this._votes = new Map();
    this._speechQueue = [];
    this._speechIndex = 0;
    this._victim = null;
    this._saved = null;
    this._poisoned = null;
  }

  join({ id, name } = {}) {
    if (this.phase !== 'lobby') fail('游戏已开始，请等待本局结束');
    if (typeof id !== 'string' || !id || id.length > 128 || this.players.some(p => p.id === id)) fail('玩家身份无效或已入座');
    const safeName = cleanName(name);
    if (!safeName) fail('请输入玩家名字');
    if (this.players.length >= 6) fail('房间已满，最多六人');
    const seat = [1, 2, 3, 4, 5, 6].find(n => !this.players.some(p => p.seat === n));
    this.players.push({ id, seat, name: safeName, bot: false, connected: true, alive: true, role: null, clues: [], potions: null });
    this.players.sort((a, b) => a.seat - b.seat);
    this._chooseHost();
    this.revision++;
    return seat;
  }

  setConnected(id, connected) {
    const player = this.players.find(p => p.id === id);
    if (!player || player.bot) return false;
    if (player.connected === Boolean(connected)) return false;
    player.connected = Boolean(connected);
    this._chooseHost();
    this.revision++;
    return true;
  }

  leave(id) {
    const player = this.players.find(p => p.id === id);
    if (!player || player.bot) return false;
    if (this.phase === 'lobby') this.players = this.players.filter(p => p.id !== id);
    else player.connected = false;
    this._chooseHost();
    this.revision++;
    return true;
  }

  start(actorId) {
    this._requireHuman(actorId);
    if (this.phase !== 'lobby') fail('本局已经开始');
    if (!this.players.some(p => !p.bot && p.connected)) fail('至少需要一位在线玩家');
    // Offline lobby seats do not become silent participants; their slot becomes AI.
    this.players = this.players.filter(p => p.connected && !p.bot);
    // Freeze the opening rule at deal time; reconnects never change game rules.
    this._peacefulFirstNight = this.players.length === 1;
    for (let seat = 1; seat <= 6; seat++) {
      if (!this.players.some(p => p.seat === seat)) {
        let id;
        do { id = `bot-${++this._botSequence}`; } while (this.players.some(p => p.id === id));
        this.players.push({ id, seat, name: BOT_NAMES[seat - 1], bot: true, connected: true, alive: true, role: null, clues: [], potions: null });
      }
    }
    this.players.sort((a, b) => a.seat - b.seat);
    const roles = [...ROLES];
    for (let i = roles.length - 1; i > 0; i--) {
      const sample = this.random();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) fail('随机数生成器返回无效值');
      const j = Math.floor(sample * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    this.players.forEach((p, index) => {
      p.role = roles[index];
      p.alive = true;
      p.clues = [];
      p.potions = p.role === 'witch' ? { save: true, poison: true } : null;
    });
    this.round = 1;
    this.result = null;
    this.speech = null;
    this.logs = [];
    this._log('本局开始：六人桌，两名狼人、预言家、女巫、两名村民。');
    if (this._peacefulFirstNight) this._log('单人练习：首夜平安，只进行预言家查验，不袭击、不使用药水。天亮后所有人进入发言，第二夜起恢复正常规则。');
    this._storyPush('host', '地下城城主', '月影从高墙后升起，六把椅子围着一张旧木桌。门已经落锁，只有你们的声音能把这座城继续往前推。');
    this._beginNight();
    this.revision++;
  }

  act(actorId, action) {
    const player = this.players.find(p => p.id === actorId);
    if (!player || !player.alive || (!player.bot && !player.connected)) fail('当前玩家无法行动');
    if (this.deadline !== null && this.now() >= this.deadline) {
      this.tick();
      fail('本次行动已超时，请按最新状态操作');
    }
    const prompt = this._prompt(player);
    if (!prompt || !action || typeof action !== 'object' || action.kind !== prompt.kind) fail('当前不是你的行动回合');
    if (action.kind === 'speech') {
      if (typeof action.text !== 'string') fail('请填写发言内容');
      const text = action.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
      if (!text || Array.from(text).length > 240) fail('发言须为一至 240 个字');
      this.speech = { id: `${this.roomId}-${++this._sequence}`, seat: player.seat, name: player.name, text };
      this._log(`${player.seat} 号 ${player.name}：${text}`);
      this._storyPush(player.bot ? 'agent' : 'human', player.name, text);
      this.phase = 'playback';
      this.deadline = this.now() + this.durations.playback;
    } else {
      const target = action.target === undefined ? null : action.target;
      const choice = prompt.choices.find(c => c.action === action.action && c.target === target);
      if (!choice) fail('目标或行动无效，请选择当前可用选项');
      if (action.kind === 'night') {
        this._nightActions.set(player.id, { action: choice.action, target: choice.target });
        if (choice.action === 'inspect') {
          const targetPlayer = this._seat(choice.target);
          player.clues.push(`第 ${this.round} 夜查验 ${targetPlayer.seat} 号 ${targetPlayer.name}：${targetPlayer.role === 'wolf' ? '狼人阵营' : '好人阵营'}。`);
          player.clues = player.clues.slice(-100);
        }
        if (choice.action === 'save') {
          player.potions.save = false;
          this._saved = choice.target;
        }
        if (choice.action === 'poison') {
          player.potions.poison = false;
          this._poisoned = choice.target;
        }
        this._advanceNight();
      } else {
        this._votes.set(player.id, choice.target);
        if (this._alive().every(p => this._votes.has(p.id))) this._resolveVote();
      }
    }
    this.revision++;
  }

  completePlayback(speechId) {
    if (this.phase !== 'playback' || !this.speech || this.speech.id !== speechId) return false;
    this.speech = null;
    this._speechIndex++;
    this._advanceSpeech();
    this.revision++;
    return true;
  }

  tick() {
    if (this.deadline === null || this.now() < this.deadline) return false;
    if (this.phase === 'night') {
      for (const player of this._nightActors()) {
        if (!this._nightActions.has(player.id)) this._nightActions.set(player.id, { action: 'skip', target: null });
      }
      this._advanceNight();
    } else if (this.phase === 'speech') {
      const player = this._seat(this._speechQueue[this._speechIndex]);
      if (player) this._log(`${player.seat} 号 ${player.name}${player.bot ? '（AI）' : ''}未在时限内发言，已跳过。`);
      this._speechIndex++;
      this._advanceSpeech();
    } else if (this.phase === 'playback') {
      this.speech = null;
      this._speechIndex++;
      this._advanceSpeech();
    } else if (this.phase === 'vote') {
      for (const player of this._alive()) if (!this._votes.has(player.id)) this._votes.set(player.id, null);
      this._resolveVote();
    } else return false;
    this.revision++;
    return true;
  }

  restart(actorId) {
    this._requireHuman(actorId);
    if (this.phase !== 'result') fail('本局结束后才能重新开局');
    this.players = this.players.filter(p => !p.bot && p.connected).map(p => ({ ...p, alive: true, role: null, clues: [], potions: null }));
    this.phase = 'lobby';
    this.deadline = null;
    this.round = 0;
    this.result = null;
    this.speech = null;
    this.logs = [];
    this._nightStage = null;
    this._nightActions.clear();
    this._votes.clear();
    this._speechQueue = [];
    this._speechIndex = 0;
    this._victim = this._saved = this._poisoned = null;
    this._peacefulFirstNight = false;
    this.story = { messages: [] };
    this._chooseHost();
    this.revision++;
  }

  view(actorId) {
    const player = this.players.find(p => p.id === actorId);
    if (!player) fail('玩家不在房间中');
    let self = null;
    if (player.role && this.phase !== 'lobby') {
      self = { role: player.role, roleName: ROLE_NAMES[player.role], team: player.role === 'wolf' ? 'wolves' : 'villagers', clues: [...player.clues] };
      if (player.role === 'wolf') {
        for (const teammate of this.players.filter(p => p.role === 'wolf' && p.id !== actorId)) self.clues.push(`你的狼队友是 ${teammate.seat} 号 ${teammate.name}（${teammate.alive ? '存活' : '已出局'}）。`);
      }
      if (player.potions) {
        self.potions = { ...player.potions };
        if (player.potions.save && this.phase === 'night' && this._nightStage === 'witch' && player.alive) self.potions.threatenedSeat = this._victim;
      }
    }
    return clone({
      roomId: this.roomId, revision: this.revision, round: this.round,
      phase: this.phase, phaseLabel: LABELS[this.phase], deadline: this.deadline,
      rules: { peacefulFirstNight: this._peacefulFirstNight },
      hostId: this.hostId, selfId: actorId, selfSeat: player.seat,
      players: this.players.map(p => ({ id: p.id, seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, alive: p.alive, ...((p.id === actorId || this.phase === 'result') && p.role ? { role: p.role } : {}) })),
      self, prompt: player.alive && (player.bot || player.connected) ? this._prompt(player) : null,
      speech: this.speech, logs: this.logs, result: this.result, story: this.story,
      canStart: this.phase === 'lobby' && !player.bot && player.connected,
      canRestart: this.phase === 'result' && !player.bot && player.connected,
    });
  }

  pendingAI() {
    for (const player of this.players) {
      if (!player.bot || !player.alive) continue;
      const projection = this.view(player.id);
      if (projection.prompt) return { playerId: player.id, revision: this.revision, context: projection, choices: clone(projection.prompt.choices), kind: projection.prompt.kind };
    }
    return null;
  }

  _seat(seat) { return this.players.find(p => p.seat === seat); }
  _alive() { return this.players.filter(p => p.alive); }
  _storyPush(kind, name, text) {
    const clean = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (!clean) return;
    this.story.messages.push({ id: 'story-' + (++this._sequence), round: this.round, kind, name: String(name || '地下城城主').slice(0, 24), text: Array.from(clean).slice(0, 320).join('') });
    this.story.messages = this.story.messages.slice(-100);
  }
  storyChat(actorId, rawText) {
    this._requireHuman(actorId);
    if (this.phase === 'lobby') fail('进入故事后才能和地下城城主对话');
    if (this.phase === 'result') fail('本局已经落幕，请重新开局再进入故事');
    const text = typeof rawText === 'string' ? rawText.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim() : '';
    if (!text || Array.from(text).length > 240) fail('城主对话须为一至 240 个字');
    const player = this.players.find(p => p.id === actorId);
    this._storyPush('human', player.name, text);
    this.revision++;
  }
  storyHost(text) {
    if (this.phase === 'lobby' || this.phase === 'result') return false;
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean || Array.from(clean).length > 320) return false;
    this._storyPush('host', '地下城城主', clean);
    this.revision++;
    return true;
  }
  _log(text) {
    this.logs.push({ id: `event-${++this._sequence}`, round: this.round, text });
    this.logs = this.logs.slice(-200);
  }
  _chooseHost() {
    if (!this.players.some(p => p.id === this.hostId && !p.bot && p.connected)) this.hostId = this.players.find(p => !p.bot && p.connected)?.id ?? null;
  }
  _requireHuman(actorId) {
    if (!this.players.some(p => p.id === actorId && p.connected && !p.bot)) fail('只有已入座的在线真人可以操作');
  }
  _nightActors() {
    const role = { wolves: 'wolf', seer: 'seer', witch: 'witch' }[this._nightStage];
    return this._alive().filter(p => p.role === role);
  }
  _beginNight() {
    this.phase = 'night';
    this.speech = null;
    this._nightStage = this._isPeacefulOpening() ? 'seer' : 'wolves';
    this._nightActions.clear();
    this._victim = this._saved = this._poisoned = null;
    this.deadline = this.now() + this.durations.night;
    this._log(`第 ${this.round} 夜，天黑请闭眼。`);
    this._storyPush('host', '地下城城主', this._isPeacefulOpening()
      ? '第一声钟响得很轻。夜色没有伸手夺走任何人，只把一枚看不见的疑问放在桌心：你愿意先相信谁？'
      : `第 ${this.round} 夜降临，风从门缝里钻进来，烛火朝着同一个方向偏去。轮到你们决定，今晚谁会被黑暗记住。`);
    this._advanceNight();
  }
  _advanceNight() {
    while (this.phase === 'night') {
      const actors = this._nightActors();
      // A witch with no usable action does not delay the rest of the table.
      if (this._nightStage === 'witch') for (const p of actors) {
        if (!p.potions.poison && (!p.potions.save || this._victim === null)) this._nightActions.set(p.id, { action: 'skip', target: null });
      }
      if (actors.some(p => !this._nightActions.has(p.id))) return;
      if (this._nightStage === 'wolves') {
        const counts = new Map();
        for (const p of actors) {
          const action = this._nightActions.get(p.id);
          if (action?.action === 'kill') counts.set(action.target, (counts.get(action.target) || 0) + 1);
        }
        const highest = Math.max(0, ...counts.values());
        const tied = [...counts].filter(([, count]) => count === highest).map(([seat]) => seat).sort((a, b) => a - b);
        this._victim = tied.length > 1 ? tied[this._randomIndex(tied.length)] : tied[0] ?? null;
        this._nightStage = 'seer';
      } else if (this._nightStage === 'seer') {
        if (this._isPeacefulOpening()) { this._resolveNight(); return; }
        this._nightStage = 'witch';
      }
      else { this._resolveNight(); return; }
      this._nightActions.clear();
      this.deadline = this.now() + this.durations.night;
    }
  }
  _resolveNight() {
    const dead = new Set();
    if (this._victim !== null && this._saved !== this._victim) dead.add(this._victim);
    if (this._poisoned !== null) dead.add(this._poisoned);
    for (const seat of dead) this._seat(seat).alive = false;
    this._log(dead.size ? `天亮了，${[...dead].sort((a, b) => a - b).map(n => `${n} 号`).join('、')}玩家出局。` : this._isPeacefulOpening() ? '天亮了，单人练习首夜平安，所有玩家进入发言。' : '天亮了，昨夜平安。');
    this._storyPush('host', '地下城城主', dead.size
      ? `天快亮时，城墙外传来一声闷响。${[...dead].sort((a, b) => a - b).map(n => `${n}号的椅子空了`).join('，')}，剩下的人只能把没说完的话带进白天。`
      : '晨雾贴着窗沿散开，六把椅子都还在。可每个人都知道，平安并不等于什么都没有发生。');
    this._nightStage = null;
    this._nightActions.clear();
    if (this._checkWinner()) return;
    this._speechQueue = this._alive().map(p => p.seat);
    this._speechIndex = 0;
    this._advanceSpeech();
  }
  _advanceSpeech() {
    this.speech = null;
    if (this._speechIndex >= this._speechQueue.length) {
      this.phase = 'vote';
      this._votes.clear();
      this.deadline = this.now() + this.durations.vote;
      this._log('发言结束，请投票放逐一名玩家；可弃票，平票无人出局。');
      this._storyPush('host', '地下城城主', '最后一句话落下，桌面安静了半拍。每个人都握着自己的判断，票纸在烛影里等着被写下。');
    } else {
      this.phase = 'speech';
      this.deadline = this.now() + this.durations.speech;
      const player = this._seat(this._speechQueue[this._speechIndex]);
      if (player) this._storyPush('host', '地下城城主', `${player.seat}号，轮到你了。所有人的目光都转过来，先说一句你真正注意到的事。`);
    }
  }
  _resolveVote() {
    const counts = new Map();
    const tally = [];
    for (const p of this._alive()) {
      const target = this._votes.get(p.id) ?? null;
      tally.push(`${p.seat}号→${target === null ? '弃票' : `${target}号`}`);
      if (target !== null) counts.set(target, (counts.get(target) || 0) + 1);
    }
    this._log(`投票结果：${tally.join('，')}。`);
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) {
      const eliminated = this._seat(ranked[0][0]);
      eliminated.alive = false;
      this._log(`${eliminated.seat} 号 ${eliminated.name}被放逐出局（${ranked[0][1]} 票）。`);
      this._storyPush('host', '地下城城主', `票纸被推到桌心，${eliminated.seat}号的名字停在最上面。椅子向后拖开时，屋里没有人敢先松气。`);
    } else {
      this._log(ranked.length ? '本轮平票，无人出局。' : '本轮全部弃票，无人出局。');
      this._storyPush('host', '地下城城主', ranked.length ? '票纸分成两堆，谁也没有赢过沉默。平票，无人离席，但怀疑已经在桌边留下了影子。' : '所有人都把票压在掌心。没有人离席，可这份沉默比一句指认更让人不安。');
    }
    this._votes.clear();
    if (this._checkWinner()) return;
    this.round++;
    this._beginNight();
  }
  _checkWinner() {
    const wolves = this._alive().filter(p => p.role === 'wolf').length;
    const good = this._alive().length - wolves;
    if (wolves > 0 && wolves < good) return false;
    this.result = wolves === 0 ? { winner: 'villagers', reason: '所有狼人均已出局，好人阵营获胜。' } : { winner: 'wolves', reason: '存活狼人数达到或超过好人数，狼人阵营获胜。' };
    this.phase = 'result';
    this.deadline = null;
    this.speech = null;
    this._log(this.result.reason);
    this._storyPush('host', '地下城城主', wolves === 0
      ? '最后一层雾散开了。城门上的狼影熄灭，幸存者终于看见彼此真正的脸。'
      : '钟声在城里回荡，狼影已经压过了火光。故事没有替谁辩护，只记住了你们一路说过的话。');
    return true;
  }
  _isPeacefulOpening() { return this._peacefulFirstNight && this.round === 1; }
  _randomIndex(length) {
    const sample = this.random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) fail('随机数生成器返回无效值');
    return Math.floor(sample * length);
  }
  _prompt(player) {
    if (!player.alive || this.phase === 'result' || this.phase === 'lobby' || this.phase === 'playback') return null;
    const option = (p, action) => ({ target: p.seat, action, label: `${p.seat} 号 ${p.name}` });
    const skip = { target: null, action: 'skip', label: '跳过' };
    if (this.phase === 'speech') return this._speechQueue[this._speechIndex] === player.seat ? { kind: 'speech', label: '轮到你发言，限 240 字', choices: [] } : null;
    if (this.phase === 'vote') return this._votes.has(player.id) ? null : { kind: 'vote', label: '投票放逐；平票无人出局', choices: [...this._alive().filter(p => p.id !== player.id).map(p => option(p, 'vote')), { ...skip, label: '弃票' }] };
    if (this._nightActions.has(player.id) || !this._nightActors().some(p => p.id === player.id)) return null;
    if (this._nightStage === 'wolves') return { kind: 'night', label: '选择袭击对象；狼队平票时在最高票目标中随机决定', choices: [...this._alive().filter(p => p.role !== 'wolf').map(p => option(p, 'kill')), skip] };
    if (this._nightStage === 'seer') return { kind: 'night', label: '查验一名玩家的阵营', choices: [...this._alive().filter(p => p.id !== player.id).map(p => option(p, 'inspect')), skip] };
    const choices = [];
    if (player.potions.save && this._victim !== null) choices.push({ target: this._victim, action: 'save', label: `解药：救 ${this._victim} 号 ${this._seat(this._victim).name}` });
    if (player.potions.poison) choices.push(...this._alive().map(p => ({ ...option(p, 'poison'), label: `毒药：${p.seat} 号 ${p.name}` })));
    choices.push(skip);
    return { kind: 'night', label: '解药和毒药各一瓶；每夜最多用一瓶，可自救', choices };
  }
}
