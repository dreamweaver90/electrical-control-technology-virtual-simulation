/**
 * 虚拟接线仿真系统 — 磁性传感器（magnetic-sensor.js）
 *
 * MagneticSensorInstance：三线制磁性接近开关（NPN/PNP），检测气缸位置。
 *
 * 电气模型（scan 读数值层 solve，单次扫描不迭代，触点滞后一 tick 惯例）：
 *   工作 = 红/蓝同在 DC 岛 ∧ U红−U蓝 为正（红高蓝低）∧
 *          |ΔU| ∈ [workingVoltage×(1−voltTol), workingVoltage×(1+voltTol)]
 *   到位 = 绑定气缸（relative-position 能力）∧ |position − detect| ≤ tolerance
 *   输出 = 工作 ∧ 到位 ∧ 型号匹配：
 *          NPN → out_npn（黑-蓝 触点闭合，负载接红-黑）
 *          PNP → out_pnp（黑-红 触点闭合，负载接蓝-黑）
 *   报警（collectAlerts 钩子，引擎统一告警栈汇总）：接交流（AC 岛有压）/ 超压（DC 且 > 上限）。
 *   反接（红低蓝高）不工作不报警；欠压不工作不报警；未绑定气缸永不导通。
 *
 * 参数（配置驱动）：target（bind 绑定气缸）/ unit（动态下拉 = 绑定气缸单元 label）/
 *   detect（检测位置 0~1）/ tolerance（到位容差）/ sensorType（npn|pnp）/
 *   workingVoltage（额定电压）/ voltTol（±容差）；out_npn/out_pnp/lit 为运行时状态键。
 * 触点：npn {black-blue, when out_npn} / pnp {black-red, when out_pnp}（纯配置）。
 */
import { ComponentInstance } from './component-base.js';
// 全局单例用别名 GS：scan(G, ctx) 的参数 G 是并查集，会遮蔽模块级 G（GS.panel.instances 查绑定目标）
import { G as GS } from '../globals.js';

export class MagneticSensorInstance extends ComponentInstance {
  constructor(def, rowIndex) {
    super(def, rowIndex);
    this._acAlarm = false;   // 接交流报警标记（scan 写入，collectAlerts 汇报）
    this._ovAlarm = false;   // 超压报警标记
  }

  scan(G, ctx) {
    super.scan(G, ctx);   // 基类：when/timing 触点求值（用上一 tick 的输出键，全系统惯例）
    const solve = ctx && ctx.solve;
    const red = this.terminals.find(t => t.id === 'red');
    const blue = this.terminals.find(t => t.id === 'blue');

    let working = false, atPos = false, acAlarm = false, ovAlarm = false;

    // ① 电源判定：红高蓝低（正极性）∧ DC 岛 ∧ 电压 ∈ 额定±voltTol
    if (solve && red && blue) {
      const pr = solve.potential(red), pb = solve.potential(blue);
      if (pr && pb) {
        const duRe = pr.re - pb.re;
        const duIm = (pr.im || 0) - (pb.im || 0);
        const abs = Math.hypot(duRe, duIm);
        const dom = solve.domainOf(red) || '';
        if (dom.startsWith('dc')) {
          if (duRe > 0) {   // 正极性（红高蓝低）；反接不工作不报警
            const V = this.params.workingVoltage || 24;
            const tol = this.params.voltTol != null ? this.params.voltTol : 0.1;
            const lo = V * (1 - tol), hi = V * (1 + tol);
            if (abs >= lo && abs <= hi) working = true;
            else if (abs > hi) ovAlarm = true;   // 超压
          }   // 欠压：不工作不报警
        } else if (dom.startsWith('ac') && abs > 0.1) {
          acAlarm = true;   // 接交流报警
        }
      }
    }

    // ② 到位判定：绑定气缸（relative-position 能力）→ 指定单元的当前位置与 detect 比较
    if (working) {
      const target = GS.panel && GS.panel.instances.get(this.params.target);
      if (target && typeof target.relativePositions === 'function') {
        const u = target.relativePositions()[Number(this.params.unit ?? 0)];
        if (u) {
          const det = this.params.detect != null ? this.params.detect : 1;
          const tol = this.params.tolerance != null ? this.params.tolerance : 0.02;
          atPos = Math.abs(u.position - det) <= tol + 1e-9;   // +1e-9 防浮点误差（如 0.52-0.5=0.020000000000000018）
        }
      }
    }

    // ③ 输出状态键（触点 when 引用；lit 驱动 LED 图层显隐）
    const lit = working && atPos;
    const outN = lit && this.params.sensorType === 'npn';
    const outP = lit && this.params.sensorType === 'pnp';
    const changed = lit !== this.params.lit || outN !== this.params.out_npn || outP !== this.params.out_pnp;
    this.params.out_npn = outN;
    this.params.out_pnp = outP;
    this.params.lit = lit;
    this._acAlarm = acAlarm;
    this._ovAlarm = ovAlarm;
    return changed;   // engine 按返回值集中 refreshDisplay（bind 图层显隐只在 refreshDisplay 更新）
  }

  /** 器件级告警（基类钩子）：接交流 / 超压；恢复自动消失（引擎按 key 增量 diff） */
  collectAlerts() {
    const out = [];
    if (this._acAlarm) out.push({ key: 'ac_' + this.instanceId, icon: '⚠', text: '磁性传感器接入交流电源！' + this.displayName(), bg: '#e74c3c' });
    if (this._ovAlarm) out.push({ key: 'ov_' + this.instanceId, icon: '⚠', text: '磁性传感器电源超压！' + this.displayName(), bg: '#e74c3c' });
    return out;
  }
}
