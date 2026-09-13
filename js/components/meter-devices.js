/**
 * 虚拟接线仿真系统 — 仪表（meter-devices.js）
 *
 * VoltmeterInstance      电压表 —— 并联测量电位差，自动 AC/DC 显示
 * AmmeterInstance        电流表 —— 串联测量（结构层恒连 + 数值层分流电阻）
 * ElectricMeterInstance  电能表 —— 电流线圈（sensors 支路）+ 并联电压，实时功率 kW + 累计电能 kW·h
 * SpeedMeterInstance     指针式转速表 —— bind 参数绑定 speed 器件，每 tick 读 getSpeed() 驱动指针（anims）
 * 读数写入 image 层中带 data-mv 属性的元素（配置字符串约定；key 指定 data-mv 属性值过滤）。
 */
import { ComponentInstance } from './component-base.js';
import { G as GS } from '../globals.js';

/** 仪表公共基类：读数写入 image 层中带 data-mv 属性的元素（配置字符串约定） */
class MeterInstance extends ComponentInstance {
  _setReadout(t, key) {
    if (!this.el) return;
    const sel = key ? '[data-mv="' + key + '"]' : '[data-mv]';
    this.el.querySelectorAll(sel).forEach(el => { if (el.textContent !== t) el.textContent = t; });
  }
}

/**
 * 电压表 —— 并联测量端子电位差（内部开路，不参与电路）。
 * 不区分直流/交流仪表：按所在岛域自动显示 "AC 220.0V" / "DC +24.0V" / "DC -24.0V"
 * （直流带极性：t1(电压+) − t2(电压−)，反接显示负值），未定义显示 "---"。
 */
export class VoltmeterInstance extends MeterInstance {
  scan(G, ctx) {
    super.scan(G, ctx);
    const solve = ctx && ctx.solve;
    if (!solve) return false;
    const terms = this.terminals.filter(t => !t.isHidden);
    let text = '---';
    if (terms.length >= 2) {
      const a = terms[0], b = terms[1];
      const p1 = solve.potential(a), p2 = solve.potential(b);
      const d1 = solve.domainOf(a);
      // 同一电位参考系（同岛或同电源，如三相电源 L1-N）才有效；不同参考系（独立整流器间）→ '---'
      if (p1 && p2 && d1 && solve.sameReference(a, b)) {
        if (d1.startsWith('ac')) {
          const mag = Math.hypot(p1.re - p2.re, p1.im - p2.im);
          text = 'AC ' + mag.toFixed(1) + 'V';
        } else {
          // 直流带极性：t1(电压+) − t2(电压−)，反接显示负值
          const diff = p1.re - p2.re;
          text = 'DC ' + (Math.abs(diff) < 0.05 ? '0.0' : (diff > 0 ? '+' : '-') + Math.abs(diff).toFixed(1)) + 'V';
        }
      }
    }
    this._setReadout(text);
    return false;
  }
}

/**
 * 电流表 —— 串联测量：sensors 条目（结构层恒连如导线，数值层小分流电阻支路，基类 numericBranches 处理）。
 * 显示 "AC 1.42A" / "DC +0.50A"（直流带极性：支路方向 = 传感器条目 a→b，a 接电源侧为正，反接显示负值），未定义显示 "---"。
 */
export class AmmeterInstance extends MeterInstance {
  scan(G, ctx) {
    super.scan(G, ctx);
    const solve = ctx && ctx.solve;
    if (!solve) return false;
    let text = '---';
    const e = this.pairEntries.sensors[0];
    if (e && e.pairs.length && solve) {
      const cur = solve.currentOf(this, 'sensor:' + e.key + ':0');
      if (cur) {
        const dom = solve.domainOf(e.pairs[0][0]);
        if (dom && dom.startsWith('dc')) {
          // 直流带极性：re 为支路直流电流（a→b 为正），反接显示负值；±5mA 内显示 0.00
          const r = cur.re;
          text = 'DC ' + (Math.abs(r) < 0.005 ? '0.00' : (r > 0 ? '+' : '-') + Math.abs(r).toFixed(2)) + 'A';
        } else {
          const mag = Math.hypot(cur.re, cur.im);
          text = (dom && dom.startsWith('ac') ? 'AC ' : '') + mag.toFixed(2) + 'A';
        }
      }
    }
    this._setReadout(text);
    return false;
  }
}

/**
 * 电能表 —— 串联电流线圈（sensors 支路，结构层恒连/数值层小阻值）+ 并联电压（恒连端子对）。
 * 接线：t1(1) 接电源 L、t2(2) 接负载（电流回路串联）；t3(3) 接 N、t4(4) 接负载（t3-t4 内部连通）。
 * 实时功率 P = Re(U·conj(I))（U = t1−t3 电压相量差，I = 电流线圈支路电流），显示 kW；
 * 累计电能按仿真时间（tick 计数）积分（只累计正功率），显示 kW·h。
 * 电压/电流/参考系判定全部复用 SolveResult（potential/sameReference/currentOf），无重复实现。
 */
export class ElectricMeterInstance extends MeterInstance {
  constructor(def, rowIndex) {
    super(def, rowIndex);
    this._energyKWh = 0;    // 累计电能（kW·h）
    this._lastTime = null;  // 上次 scan 时刻（按仿真时间积分）
  }

  scan(G, ctx) {
    super.scan(G, ctx);
    const now = (ctx && ctx.tickMs) || Date.now();   // 仿真时间（tick 计数，与电气侧时序一致；后台节流不失真）
    const dt = this._lastTime !== null ? (now - this._lastTime) / 1000 : 0;   // 仿真流逝秒
    this._lastTime = now;
    const solve = ctx && ctx.solve;
    const curE = this.pairEntries.sensors[0];            // 电流线圈（1-2）
    const volE = this.pairEntries.permanent[0];          // 3-4 内部连通 → a 端即 t3
    const ua = curE && curE.pairs[0] && curE.pairs[0][0];   // t1（接电源 L）
    const ub = volE && volE.pairs[0] && volE.pairs[0][0];   // t3（接 N）
    let pText = '---';
    if (solve && ua && ub) {
      const p1 = solve.potential(ua), p3 = solve.potential(ub);
      const cur = curE ? solve.currentOf(this, 'sensor:' + curE.key + ':0') : null;
      if (p1 && p3 && cur && solve.sameReference(ua, ub)) {
        const U = { re: p1.re - p3.re, im: p1.im - p3.im };
        const Pw = U.re * cur.re + U.im * cur.im;            // 实功率 P = Re(U·conj(I))，瓦
        const PkW = Math.max(0, Pw) / 1000;
        if (dt > 0) this._energyKWh += PkW * dt / 3600;      // kW·h = kW × 实际小时（只累计正功率）
        pText = PkW.toFixed(5);
      }
    }
    this._setReadout(pText, 'p');
    this._setReadout(this._energyKWh.toFixed(5), 'e');
    return false;
  }
}

/**
 * 指针式转速表 —— bind 参数绑定具备 speed 能力的器件（如电机），
 * 每 tick 读目标 getSpeed()（带符号 rpm：cw 正/ccw 负）写 params.needle_pos，
 * 指针角度由 image 条目 anims 绑定（map 引用 params.posRange 对称量程：-量程..+量程）。
 * 绑定目标删除后 param-panel 自动清空 target → 显示 0。
 */
export class SpeedMeterInstance extends ComponentInstance {
  scan(G, ctx) {
    super.scan(G, ctx);   // 基类：when 求值 + 动画刷新（先于本类写 needle_pos → 变化时补刷新当 tick 生效）
    const target = GS.panel && GS.panel.instances.get(this.params.target);
    const spd = target && typeof target.getSpeed === 'function' ? target.getSpeed() : 0;
    if (this.params.needle_pos !== spd) {
      this.params.needle_pos = spd;
      this.refreshDisplay();   // 指针动画刷新（值变化才调用；稳态转速下零开销）
    }
    return false;
  }
}
