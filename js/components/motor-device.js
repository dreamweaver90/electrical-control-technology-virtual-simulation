/**
 * 虚拟接线仿真系统 — 三相异步电动机（motor-device.js）
 *
 * MotorInstance：
 *   - 三相绕组 = 3 个 computed:"motor" 的 loads 条目（pins = [首端, 尾端]，Terminal 引用）。
 *   - 运行判定（每 tick 读数值层相量电位 solve.potential）：三绕组电压相量三相平衡
 *     （幅值接近、相位两两 120°）且不低于启动门槛 → 判"能转"；相序 = 绕组电压相位
 *     旋转方向 → 正转/反转。接法（Y/Δ）、供电是否串阻抗或经变压器，都自然体现在电压
 *     与电流里，无需按拓扑识别。
 *   - 绕组阻抗双态（额定运转 Z_run / 堵转 Z_lock，computed 钩子选型）：上一 tick 判定
 *     能转且未堵转 → Z_run；否则 Z_lock（静止合闸第一拍即 Z_lock，产生启动浪涌电流）。
 *   - 堵转：params.target 绑定 relative-position 执行机构，方向顶到行程端 → speed 钳 0。
 *   - speed 能力：getSpeed() 返回带符号转速（rpm）。
 */
import { ComponentInstance } from './component-base.js';
// 全局单例用别名 GS：scan(G, ctx) 的参数 G 是并查集，会遮蔽模块级 G（GS.faultManager 等）
import { G as GS } from '../globals.js';

export class MotorInstance extends ComponentInstance {
  static capabilities = ['speed'];

  constructor(def, rowIndex) {
    super(def, rowIndex);
    this._rotating = false;      // 上一 tick 是否判"能转"（决定本 tick 绕组阻抗选型）
    this._Zrun = null;           // 运转态绕组阻抗相量（预计算缓存）
    this._Zlock = null;          // 堵转态绕组阻抗相量（预计算缓存）
    this._calcWindingZ();
    // 可选速度继电器触点配置（def.raw.speedRelay）：[{stateKey, dir:'pos'|'neg'}]，
    // pos → speed > +threshold 动作；neg → speed < -threshold 动作；无该配置零影响。
    const sr = def.raw && def.raw.speedRelay;
    this._speedRelay = Array.isArray(sr)
      ? sr.map(r => ({ stateKey: r.stateKey, dir: r.dir === 'neg' ? 'neg' : 'pos' }))
      : [];
  }

  /** speed 能力契约方法：当前转速（rpm），0 = 停止 */
  getSpeed() {
    return this.params.speed || 0;
  }

  /**
   * 堵转判定（params.target 绑定 relative-position 执行机构；未绑定恒 false）。
   * 机械映射固定：正转(cw) → 执行机构位置增大。
   * 堵转 = 上一 tick 能转(_rotating) ∧ 通电方向把执行机构往行程端外推：
   *   cw ∧ 位置 ≥ 1−ε  /  ccw ∧ 位置 ≤ ε。
   * 堵转中 speed 钳 0；解除 = 反向 ∨ 位置离开端 ∨ 断电/接法异常。
   */
  _tickStall() {
    const bound = GS.panel && GS.panel.instances.get(this.params.target);
    let stalled = false;
    if (bound && this._rotating && typeof bound.relativePositions === 'function') {
      const u = bound.relativePositions()[Number(this.params.unit ?? 0)];
      const pos = u ? u.position : null;
      if (pos != null) {
        const eps = 1e-6;
        if (this.params.cw)       stalled = pos >= 1 - eps;
        else if (this.params.ccw) stalled = pos <= eps;
      }
    }
    if (stalled) this.params.speed = 0;
    if (this.params.stalled !== stalled) {
      this.params.stalled = stalled;
      this.refreshDisplay();
    }
    return stalled;
  }

  /** 转速动态模型：通电按 accelTimeOn 匀加速至额定（cw + / ccw −），断电按 accelTimeOff 减速至 0 */
  _tickSpeed() {
    const rated = this.params.ratedSpeed || 1450;
    const dt = ((GS.config && GS.config.simulation && GS.config.simulation.refreshIntervalMs) || 50) / 1000;
    const aOn = rated / Math.max(0.01, this.params.accelTimeOn || 1);
    const aOff = rated / Math.max(0.01, this.params.accelTimeOff || 5);
    let v = this.params.speed || 0;
    if (this.params.cw) {
      v = Math.min(rated, v + aOn * dt);
    } else if (this.params.ccw) {
      v = Math.max(-rated, v - aOn * dt);
    } else {
      if (v > 0) v = Math.max(0, v - aOff * dt);
      else if (v < 0) v = Math.min(0, v + aOff * dt);
    }
    this.params.speed = v;
  }

  /**
   * 每相绕组阻抗由额定点反推：额定接法 ratedConnection（'Y' 缺省 / 'D'）决定额定相电压
   * （coilVoltage 一律按额定线电压解释）；|Z_相| = 3·U_相²·pf·η/P；Z_lock = Z_run / lockRatio。
   * 派生铭牌值：额定电流 = P/(√3·U·pf·η)、堵转电流 = 额定 × lockRatio。
   */
  _calcWindingZ() {
    const P = this.params || {};
    const U = P.coilVoltage || 380;
    const pw = P.ratedPower || 750;
    const pf = Math.min(1, P.powerFactor || 0.8);
    const lock = P.lockRatio || 6;
    const eff = Math.min(1, P.efficiency || 0.85);
    const uPhase = U / ((P.ratedConnection === 'D') ? 1 : Math.sqrt(3));
    const zMag = 3 * uPhase * uPhase * pf * eff / pw;
    const sin = Math.sin(Math.acos(pf));
    this._Zrun = { re: zMag * pf, im: zMag * sin };
    this._Zlock = { re: this._Zrun.re / lock, im: this._Zrun.im / lock };
    if (U > 0 && pw > 0 && pf > 0 && eff > 0) {
      const iRated = pw / (Math.sqrt(3) * U * pf * eff);
      this.params.ratedCurrent = iRated;
      this.params.stallCurrent = iRated * lock;
    }
  }

  /** 参数写回：额定参数变化 → 重算绕组阻抗缓存 */
  onParamsChanged() {
    this._calcWindingZ();
  }

  /** loads computed 阻抗钩子：能转且未堵转 → 运转阻抗；否则堵转阻抗 */
  _computedLoadImpedance(key) {
    return this._rotating && !this.params.stalled ? this._Zrun : this._Zlock;
  }

  /** 速度继电器触点判定（可选 speedRelay 配置） */
  _tickSpeedRelay() {
    const th = this.params.speedThreshold > 0 ? this.params.speedThreshold : 120;
    const s = this.params.speed || 0;
    let changed = false;
    for (const r of this._speedRelay) {
      const v = r.dir === 'neg' ? s < -th : s > th;
      if (!!this.params[r.stateKey] !== v) { this.params[r.stateKey] = v; changed = true; }
    }
    if (changed) this.refreshDisplay();
  }

  /**
   * 运行判定：由三绕组电压相量判"能否转动"与"相序"。
   *   - 任一绕组端电位缺失 → 未接通；
   *   - 幅值低于 minStartVoltage×额定相压 → 电压不足；
   *   - 三幅值相对差 > balanceTol、或相位两两差偏离 ±120° 超过 phaseTol → 不平衡；
   *   - 相序：ΔU_v 相对 ΔU_u 超前 120° → clockwise，滞后 120° → counterclockwise。
   * 返回 {dir, code}（dir: clockwise/counterclockwise/none）。
   */
  _judgeWinding(solve) {
    const ends = this.pairEntries.loads
      .filter(e => e.computed === 'motor' && e.pairs.length === 1)
      .map(e => ({ h: e.pairs[0][0], t: e.pairs[0][1] }));
    if (ends.length !== 3) return { dir: 'none', code: 'invalid' };

    const pu = ends.map(e => solve.potential(e.h));
    const pt = ends.map(e => solve.potential(e.t));
    if (pu.some(p => !p) || pt.some(p => !p)) return { dir: 'none', code: 'unconnected' };

    const dU = ends.map((_, i) => ({ re: pu[i].re - pt[i].re, im: pu[i].im - pt[i].im }));
    const mag = dU.map(d => Math.hypot(d.re, d.im));

    const U = this.params.coilVoltage || 380;
    const uPhase = U / ((this.params.ratedConnection === 'D') ? 1 : Math.sqrt(3));
    const vMin = (this.params.minStartVoltage != null ? this.params.minStartVoltage : 0.1) * uPhase;
    if (mag.some(m => m < vMin)) return { dir: 'none', code: 'undervoltage' };

    const balTol = this.params.balanceTol != null ? this.params.balanceTol : 0.1;
    const mn = Math.min(...mag), mx = Math.max(...mag);
    if (mn <= 0 || mx / mn > 1 + balTol) return { dir: 'none', code: 'unbalanced' };

    const ang = dU.map(d => Math.atan2(d.im, d.re));
    const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };
    const phaseTol = (this.params.phaseTol != null ? this.params.phaseTol : 10) * Math.PI / 180;
    const t120 = 2 * Math.PI / 3;
    const near = (x, t) => Math.abs(wrap(x - t)) <= phaseTol;
    const d1 = wrap(ang[1] - ang[0]);
    const d2 = wrap(ang[2] - ang[1]);
    if (near(d1, t120) && near(d2, t120)) return { dir: 'clockwise', code: 'ok' };
    if (near(d1, -t120) && near(d2, -t120)) return { dir: 'counterclockwise', code: 'ok' };
    return { dir: 'none', code: 'unbalanced' };
  }

  scan(G, ctx) {
    const stalled = this._tickStall();
    if (!stalled) this._tickSpeed();
    if (this._speedRelay.length) this._tickSpeedRelay();
    super.scan(G, ctx);
    this._syncTextLabels();

    const judge = this._judgeWinding(ctx && ctx.solve);
    this._rotating = judge.dir !== 'none';
    return this._applyDir(judge.dir);
  }

  /** 更新旋转状态与显示（cw/ccw 互斥），返回是否变化 */
  _applyDir(dir) {
    const cw = dir === 'clockwise', ccw = dir === 'counterclockwise';
    if (this.params.cw === cw && this.params.ccw === ccw) return false;
    this.params.cw = cw; this.params.ccw = ccw;
    this.refreshDisplay();
    return true;
  }

  /** 器件级告警：堵转中红色提示 */
  collectAlerts() {
    return this.params.stalled
      ? [{ key: 'stall_' + this.instanceId, icon: '⚠', text: '电机堵转！' + this.displayName(), bg: '#e74c3c' }]
      : [];
  }
}
