/**
 * 虚拟接线仿真系统 — 线圈得电判定共享模块（coil-judge.js）
 *
 * 接触器线圈（CoilDeviceInstance）与电磁阀线圈（PneumaticValveInstance）共用
 * 同一套"loads 条目数值层滞回判定"：
 *   |U| ≥ pickup×额定电压 → 得电；< dropout×额定电压 → 失电（滞回防抖）；
 *   params.coilVoltage（额定 V，未配/≤0 = 不判定得电）、
 *   params.coilType（'ac'/'dc'，配了才校验求解域，未配不校验）、
 *   params.pickup/params.dropout（吸合/释放阈值比例，缺省 0.85/0.6）。
 * 判定纯函数：不写任何状态，只回答"当前是否得电"。
 */

import { G as GS } from '../globals.js';

/**
 * 单线圈条目得电判定。
 * @param {ComponentInstance} inst 器件实例（读 inst.params）
 * @param {Object} e loads 条目（{pairs:[[Terminal,Terminal]]}）
 * @param {boolean} prevEnergized 上一 tick 得电状态（决定用 pickup 还是 dropout 阈值）
 * @param {Object} ctx 引擎上下文（ctx.solve = SolveResult）
 * @returns {boolean} 是否得电
 */
export function judgeCoilLoad(inst, e, prevEnergized, ctx) {
  const solve = ctx && ctx.solve;
  const p = inst.params || {};
  const rated = p.coilVoltage;
  if (!solve || !(rated && rated > 0)) return false;

  const vtype = p.coilType === 'ac' || p.coilType === 'dc' ? p.coilType : null;
  const th = prevEnergized
    ? ((p.dropout && p.dropout > 0) ? p.dropout : 0.6)
    : ((p.pickup && p.pickup > 0) ? p.pickup : 0.85);

  for (const [a, b] of e.pairs) {
    const u = solve.voltageBetween(a, b);   // 异岛/悬空 → null
    if (u === null) continue;
    if (vtype) {                            // 制式校验：ac/dc 岛匹配（未配不校验）
      const da = solve.domainOf(a);
      if (!da || !da.startsWith(vtype)) continue;
    }
    if (u >= rated * th) return true;
  }
  return false;
}

/**
 * 单线圈条目得电判定（含断路故障强制失电）——接触器线圈（CoilDeviceInstance）与
 * 电磁阀线圈（PneumaticValveInstance）共用同一入口，消除两份逐行相同的循环分叉。
 * @returns {boolean} 该条目当前是否得电（断路故障 → 恒 false）
 */
export function judgeCoilEntry(inst, e, ctx) {
  const fm = GS.faultManager;
  if (fm && fm.isEntryOpen(inst, 'loads', e.key)) return false;   // 线圈断路故障 → 强制失电（与数值层支路移除双保险）
  return judgeCoilLoad(inst, e, !!inst._coilEnergized.get(e.key), ctx);
}
