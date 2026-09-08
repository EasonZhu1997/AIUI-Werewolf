// Room numbers remain strings so four-digit IDs preserve leading zeroes.
export class RoomDigitInput {
  constructor() {
    this.room = Array(4).fill('0');
    this.stage = 'room';
    this.cursor = 0;
  }

  adjust(delta) {
    if (this.stage !== 'room' || !Number.isFinite(delta) || !delta) return false;
    this.room[this.cursor] = String((Number(this.room[this.cursor]) + (delta > 0 ? 1 : 9)) % 10);
    return true;
  }

  confirm() {
    if (this.stage === 'room' && ++this.cursor === 4) this.stage = 'done';
    return this.stage === 'done';
  }

  back() {
    if (this.stage === 'done') { this.stage = 'room'; this.cursor = 3; return true; }
    if (this.stage !== 'room') return false;
    if (this.cursor > 0) { this.cursor--; return true; }
    return false;
  }

  result() {
    return this.stage === 'done' ? { roomId: this.room.join('') } : null;
  }

  view() {
    const complete = this.stage === 'done';
    return {
      inputTitle: '输入 4 位房间号',
      inputStep: complete ? '输入完成' : `第 ${this.cursor + 1} / 4 位`,
      roomPreview: '同一个号码，进入同一个房间',
      confirmLabel: complete ? '进入房间' : this.cursor === 3 ? '确认并进入' : '确认这一位',
      cells: this.room.map((digit, index) => ({ index, active: this.stage === 'room' && index === this.cursor, text: digit })),
    };
  }

  clear() { this.room.fill('0'); this.stage = 'cancelled'; this.cursor = 0; }
}

const wrap = (angle) => ((angle + 180) % 360 + 360) % 360 - 180;

// Same [x,y,z,w] yaw convention as the official AIUI 0.17 orientation sample.
// Actual glasses axes may differ; the page exposes direction reversal/calibration.
export function quaternionYaw(quaternion) {
  if (!quaternion || quaternion.length !== 4) return null;
  const q = Array.from(quaternion);
  if (!q.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const norm = Math.sqrt(q.reduce((sum, value) => sum + value * value, 0));
  if (norm < 0.000001) return null;
  const [x, y, z, w] = q.map((value) => value / norm);
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180 / Math.PI;
}

export class YawDigitGate {
  constructor({ direction = 1, trigger = 18, neutral = 7, cooldown = 450, neutralHold = 180, calibrationMs = 600 } = {}) {
    this.direction = direction < 0 ? -1 : 1;
    this.trigger = trigger; this.neutral = neutral; this.cooldown = cooldown;
    this.neutralHold = neutralHold; this.calibrationMs = calibrationMs;
    this.reset();
  }

  reset() {
    this.center = null; this.candidate = null; this.armed = false;
    this.centerSince = null; this.lastStep = -Infinity; this.lastTime = null; this.state = 'calibrating';
  }

  suppress(now) { this.armed = false; this.centerSince = null; this.lastStep = now; if (this.center !== null) this.state = 'recenter'; }
  reverse(now) { this.direction *= -1; this.suppress(now); }

  read(angle, now) {
    if (!Number.isFinite(angle) || !Number.isFinite(now)) return 0;
    if (this.lastTime !== null && (now < this.lastTime || now - this.lastTime > 800)) this.reset();
    this.lastTime = now;
    angle = wrap(angle);
    if (this.center === null) {
      if (!this.candidate || Math.abs(wrap(angle - this.candidate.anchor)) > 3)
        this.candidate = { anchor: angle, since: now, count: 0, offset: 0 };
      this.candidate.count++;
      this.candidate.offset += wrap(angle - this.candidate.anchor);
      if (this.candidate.count >= 10 && now - this.candidate.since >= this.calibrationMs) {
        this.center = wrap(this.candidate.anchor + this.candidate.offset / this.candidate.count);
        this.armed = true; this.state = 'ready';
      }
      return 0;
    }
    const delta = wrap(angle - this.center);
    if (!this.armed) {
      if (Math.abs(delta) <= this.neutral) {
        if (this.centerSince === null) this.centerSince = now;
        if (now - this.centerSince >= this.neutralHold && now - this.lastStep >= this.cooldown) {
          this.armed = true; this.state = 'ready';
        }
      } else this.centerSince = null;
      return 0;
    }
    if (Math.abs(delta) >= this.trigger && now - this.lastStep >= this.cooldown) {
      this.suppress(now);
      return (delta > 0 ? 1 : -1) * this.direction;
    }
    return 0;
  }
}

const poseHints = {
  calibrating: '正视前方，保持片刻', ready: '左摆减一，右摆加一', recenter: '请回正，再摆一次',
  unavailable: '姿态不可用，可用左右键或按钮', stopped: '姿态已暂停；点校准可恢复',
};

// A page owns exactly one sensor lease. start() must be called from a user event;
// asynchronous error handlers never start a replacement sensor themselves.
export class PoseDigitControl {
  constructor({ createSensor, onStep, onStatus, now = () => Date.now(), timers }) {
    this.createSensor = createSensor; this.onStep = onStep; this.onStatus = onStatus;
    this.now = now; this.timers = timers; this.gate = new YawDigitGate(); this.generation = 0;
  }

  status(code) {
    if (this.statusCode === code) return;
    this.statusCode = code; this.onStatus({ code, hint: poseHints[code] });
  }

  start() {
    this.stop(); this.gate.reset(); this.status('calibrating');
    const generation = ++this.generation;
    try {
      const sensor = this.createSensor();
      if (!sensor) throw new Error('unavailable');
      this.sensor = sensor;
      this.lastReading = this.now();
      const current = () => generation === this.generation && this.sensor === sensor;
      this.reading = (event) => {
        if (!current()) return;
        try {
          const yaw = quaternionYaw(event && event.quaternion || sensor.quaternion);
          if (yaw === null) return;
          const now = this.now(); this.lastReading = now;
          const step = this.gate.read(yaw, now);
          this.status(this.gate.state);
          if (step) this.onStep(step);
        } catch (_) { if (current()) this.unavailable(); }
      };
      this.error = () => { if (current()) this.unavailable(); };
      sensor.addEventListener('reading', this.reading);
      sensor.addEventListener('error', this.error);
      const result = sensor.start();
      if (result && typeof result.catch === 'function') result.catch(this.error);
      if (!current()) return false;
      this.watchdog = this.timers.setInterval(() => {
        if (current() && this.now() - this.lastReading > 2500) this.unavailable();
      }, 500);
      return true;
    } catch (_) { this.unavailable(); return false; }
  }

  suppress() { this.gate.suppress(this.now()); if (this.sensor) this.status(this.gate.state); }
  reverse() { this.gate.reverse(this.now()); if (this.sensor) this.status(this.gate.state); return this.gate.direction; }
  unavailable() { this.stop(); this.status('unavailable'); }

  stop() {
    ++this.generation;
    if (this.watchdog !== undefined) this.timers.clearInterval(this.watchdog);
    this.watchdog = undefined;
    const sensor = this.sensor; this.sensor = null;
    if (sensor) {
      try { sensor.removeEventListener('reading', this.reading); } catch (_) {}
      try { sensor.removeEventListener('error', this.error); } catch (_) {}
      try { sensor.stop(); } catch (_) {}
    }
    this.reading = null; this.error = null;
    this.status('stopped');
  }
}
