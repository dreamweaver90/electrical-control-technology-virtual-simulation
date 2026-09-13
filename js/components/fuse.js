/**
 * 虚拟接线仿真系统 — 熔断器（fuse.js）
 *
 * FuseInstance：2P/3P 熔断器，**逐相电流判定熔断**（与断路器"结构层事件"机制不同）：
 *
 *   scan 逐相读触头支路电流（solve.currentOf，key = 'contact:<条目键>:<对索引>'）：
 *     |I| > params.fuseCurrent（熔断电流，缺省 30A，右键可调）
 *       ∧ 持续 ≥ params.fuseTime（熔断时间，缺省 0.1s，右键可调）→ 该相熔断（状态键置 true，保持）
 *   熔断 = 触点 when:"!fuse_Lx" 断开（该相触头 open）；正常相电流小 → 不熔。
 *   更换熔断器 = zones action:"reset"（每组熔丝中点热区，r18）→ 逐相复位状态键。
 *   熔断后不自动恢复（物理更换语义）。
 *
 * 相配置从 contacts 条目 when:"!状态键" 推导（零额外配置）；无 trip 能力（不走 onShortCircuit 整体跳闸）。
 */
import { ComponentInstance } from './component-base.js';
import { compileExpr } from '../bool-expr.js';

export class FuseInstance extends ComponentInstance {
  constructor(def, rowIndex) {
    super(def, rowIndex);
    // 熔丝相：触点 when 表达式（约定为"熔断状态键取反"，如 "!fuse_L1"）→ {contactKey, stateKey}
    // 表达式解析器提取键（统一用法）：keys[0] 即熔断状态键
    this._fuses = [];
    for (const e of this.pairEntries.contacts) {
      if (typeof e.when !== 'string' || !e.when) continue;
      const expr = compileExpr(e.when);
      if (!expr.keys.length) continue;
      this._fuses.push({ contactKey: e.key, stateKey: expr.keys[0] });
    }
    this._tripStart = new Map();   // stateKey → 超限起始 ms（未超限时删除，不累加）
  }

  scan(G, ctx) {
    super.scan(G, ctx);   // 基类：when/timing 触点求值（用上一 tick 熔断键，滞后一 tick 惯例）
    const solve = ctx && ctx.solve;
    if (!solve || !this._fuses.length) return false;
    const cur = this.params.fuseCurrent > 0 ? this.params.fuseCurrent : 30;
    const ms = (this.params.fuseTime > 0 ? this.params.fuseTime : 0.1) * 1000;
    const now = (ctx && ctx.tickMs) || Date.now();   // 仿真时间（tick 计数，后台节流不失真）
    let changed = false;
    for (const f of this._fuses) {
      if (this.params[f.stateKey]) continue;   // 已熔断：保持（不自动恢复）
      const c = solve.currentOf(this, 'contact:' + f.contactKey + ':0');
      const over = !!c && Math.hypot(c.re, c.im) > cur;
      if (over) {
        if (!this._tripStart.has(f.stateKey)) this._tripStart.set(f.stateKey, now);
        else if (now - this._tripStart.get(f.stateKey) >= ms) {
          this.params[f.stateKey] = true;   // 持续超限达熔断时间 → 熔断
          this._tripStart.delete(f.stateKey);
          changed = true;
        }
      } else {
        this._tripStart.delete(f.stateKey);
      }
    }
    return changed;   // engine 按返回值集中 refreshDisplay
  }

  /** 更换熔断器（zones action:"reset"，state = 该相熔断键，逐相复位） */
  handleZoneAction(id, action, phase) {
    const z = this.definition.zones && this.definition.zones.find(z => z.id === id);
    if (z && z.state && action === 'reset' && phase === 'down') {
      this.params[z.state] = false;
      this.refreshDisplay();
      return;
    }
    super.handleZoneAction(id, action, phase);
  }
}
