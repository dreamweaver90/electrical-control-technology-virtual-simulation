/**
 * 虚拟接线仿真系统 — 行程开关（limit-switch.js）
 *
 * LimitSwitchInstance：机械触点式限位开关，检测气缸（relative-position 能力）0~1 位置。
 *
 * 电气模型（scan 单次扫描，触点滞后一 tick 惯例）：
 *   位置触发 = 绑定气缸（relative-position 能力）∧ |当前位置 − detect| ≤ tolerance（默认 0.05）
 *   动作态   = 位置触发 ∨ 强制（zones 点击 (55,40) 热区 toggle forced，手动动作）
 *   动作态键 params.actuated 驱动：
 *     NO 触点 when:"actuated"（动作闭合）/ NC 触点 when:"!actuated"（动作断开）
 *     动作图（行程开关_动作.png）bind:"actuated" 显隐；强制红字 bind:"forced"。
 *   无供电端子（纯机械触点：NO 一对 + NC 一对，dir down）；无报警（机械式无电气故障判定）。
 *
 * 参数（配置驱动）：target（bind 绑定气缸）/ unit（动态下拉 = 绑定气缸单元 label）/
 *   detect（检测位置 0~1，右键可调）/ tolerance（到位容差，默认 0.05）/
 *   forced（强制键，zones toggle）/ actuated（运行时动作态键）。
 */
import { ComponentInstance } from './component-base.js';
// 全局单例用别名 GS：scan(G, ctx) 的参数 G 是并查集，会遮蔽模块级 G（GS.panel.instances 查绑定目标）
import { G as GS } from '../globals.js';

export class LimitSwitchInstance extends ComponentInstance {
  scan(G, ctx) {
    super.scan(G, ctx);   // 基类：when/timing 触点求值（用上一 tick 的动作态键，全系统惯例）

    // ① 位置触发：绑定气缸 → 指定单元的当前位置与 detect 比较（同磁性传感器机制，无供电判定）
    let atPos = false;
    const target = GS.panel && GS.panel.instances.get(this.params.target);
    if (target && typeof target.relativePositions === 'function') {
      const u = target.relativePositions()[Number(this.params.unit ?? 0)];
      if (u) {
        const det = this.params.detect != null ? this.params.detect : 1;
        const tol = this.params.tolerance != null ? this.params.tolerance : 0.05;
        atPos = Math.abs(u.position - det) <= tol + 1e-9;   // +1e-9 防浮点误差
      }
    }

    // ② 动作态 = 位置触发 ∨ 强制（zones 点击手动动作）
    const act = atPos || !!this.params.forced;
    const changed = this.params.actuated !== act;
    this.params.actuated = act;
    return changed;   // engine 按返回值集中 refreshDisplay（动作图/强制字样显隐即时刷新）
  }
}
