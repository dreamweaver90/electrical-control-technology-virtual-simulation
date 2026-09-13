/**
 * 虚拟接线仿真系统 — 指示灯（indicator.js）
 *
 * IndicatorInstance：指示灯（单灯或成组多灯模块通用）。
 *   每个灯 = 一个 loads 条目：
 *     数值支路阻抗统一来自 params（基类 numericBranches：AC 岛 z = params.impedance、
 *     DC 岛 zdc = params.dcResistance，求解器按岛类型自动选取）；
 *   亮灯判定（scan 逐灯独立）：两端 |U| ≥ params.lampVoltage×0.9（10% 额定容差，
 *     电源内阻分压使灯端电压略低于额定）且 params.lampType 与岛类型匹配（'ac'/'dc'，
 *     domainOf startsWith）→ 写状态键 e.state（如 lit_1）→ 亮图层显示；
 *   参数（右键面板可调，针对器件内所有灯生效）：lampType（ac/dc）、lampVoltage（V）、
 *   impedance（交流阻抗）、dcResistance（直流电阻）；
 *   触点/热区/能力均不需要；单灯模块（1 个 loads 条目）与多灯模块天然兼容。
 */
import { ComponentInstance } from './component-base.js';

export class IndicatorInstance extends ComponentInstance {
  scan(G, ctx) {
    super.scan(G, ctx);   // 基类 when/timing（本类无触点，空转）
    const solve = ctx && ctx.solve;
    const vtype = this.params && this.params.lampType;        // 'ac'/'dc'（未配 = 不校验类型）
    const v = this.params && this.params.lampVoltage;         // 设定电压（V）
    let changed = false;
    for (const e of this.pairEntries.loads) {
      const [a, b] = e.pairs[0] || [];
      let lit = false;
      if (solve && a && b && v > 0) {
        const u = solve.voltageBetween(a, b);                 // 异岛/悬空 → null
        // 亮灯阈值带 10% 额定容差（电源内阻分压使灯端电压略低于额定，如 24V 实测 23.997V）
        if (u !== null && u >= v * 0.9) {
          if (!vtype || (solve.domainOf(a) || '').startsWith(vtype)) lit = true;   // 类型匹配才亮
        }
      }
      const key = e.state || 'lit';                           // 单灯模块缺省 'lit'
      if (this.params[key] !== lit) { this.params[key] = lit; changed = true; }
    }
    return changed;   // engine 按返回值集中 refreshDisplay
  }
}
