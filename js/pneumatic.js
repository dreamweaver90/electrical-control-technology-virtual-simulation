/**
 * 虚拟接线仿真系统 — 气路引擎（pneumatic.js）
 *
 * 气路模型 = 结构层等压网络 + 压力源注入（不做气路 MNA 数值求解）：
 *   1. buildPneumaticGraph()  气路连通图（气路气管 + 闭合气路触点 + 气路恒连），
 *      复用 buildGraph({media:'pneumatic'})——与电气图彻底隔离；
 *   2. computePneumatics()    气压传播（恒压源直注 + 调压阀次级源迭代收敛）+
 *      串气检测（同一分量出现 ≥2 种不同压力）+ 漏气检测（有压分量的未接线开口端子）；
 *   3. isTerminalPressurized() 端子带压检测（禁止带压接线，语义同电气 isTerminalLive）。
 *
 * 排气口不建模：电磁阀排气口直接排大气（无端子），"排气位"的工作口 = 无源分量 = 0 MPa。
 */
import { G } from './globals.js';
import { buildGraph } from './graph.js';

/** 构建气路连通图（气路气管 + 闭合气路触点 + 气路恒连；故障注入跟随全局 FaultManager） */
export function buildPneumaticGraph(opts = {}) {
  return buildGraph({ ...opts, media: 'pneumatic' });
}

/* ================================================================
   气压网络计算
   ================================================================ */

/**
 * 计算全盘气压网络（每 tick 调用一次）。
 *
 * 算法：
 *   ① 气路连通图（并查集）；
 *   ② 收集全部 working 压力源（pressure-source 能力）的出气端子；
 *   ③ 迭代传播（最多 12 轮收敛）：
 *        - 恒压源（气源）：pressureValue 与进气压无关，直接注入；
 *        - 动态源（调压阀）：pressureValue(term, inletP)，inletP = 进气端子所在分量
 *          已定压力（级联调压阀逐轮传导，如 0.8 → 0.5 → 0.3 三级）；
 *      - 每轮记录分量内出现过的全部源压力值集合（供串气判定）；
 *   ④ 串气 = 某分量出现 ≥2 种不同压力（同压并联 = 正常并联，不算串气）；
 *   ⑤ 漏气 = 有压分量内"未接线"的可见端子（开口直接漏向大气）。
 *
 * @returns {{
 *   graph: UnionFind,
 *   pressure: Map<any, number>,          // 分量根 → 气压 MPa（无源分量不在表内 = 0）
 *   crossTalk: boolean,                  // 是否存在串气分量
 *   leaks: Terminal[],                   // 漏气端子列表
 *   pressureOf(term): number,            // 便捷函数：端子气压（MPa，无定义 = 0）
 * }}
 */
export function computePneumatics() {
  const graph = buildPneumaticGraph();
  const pressure = new Map();      // root → 当前分量压力（取分量内最大源值）
  const rootValues = new Map();    // root → Set(源压力值)（串气判定：>1 种不同值）

  // 收集压力源出气端子（working 才贡献压力）
  const srcs = [];
  for (const i of G.panel.instances.values()) {
    if (!i.hasCapability || !i.hasCapability('pressure-source') || !i.working) continue;
    for (const t of i.outputTerminals()) srcs.push({ i, t });
  }

  const setVal = (root, v) => {
    if (!rootValues.has(root)) rootValues.set(root, new Set());
    const vs = rootValues.get(root);
    vs.add(v);
    const cur = pressure.get(root);
    if (cur === undefined || v > cur) { pressure.set(root, v); return true; }
    return false;
  };

  // 迭代传播：动态源（调压阀）输出依赖其进气分量已定压力，级联逐轮传导
  let changed = true;
  for (let round = 0; round < 12 && changed; round++) {
    changed = false;
    for (const { i, t } of srcs) {
      const inletP = i.inletPressure
        ? i.inletPressure(graph, pressure)   // 调压阀：进气端分量压力（未定 = 0）
        : null;                              // 恒压源：无需进气
      const v = i.pressureValue(t, inletP);
      if (v == null || !(v > 0)) continue;   // 无输出（进气无压/设定无效）→ 不注入
      if (setVal(graph.find(t), v)) changed = true;
    }
    if (!changed) break;
  }

  // 串气：分量内出现 ≥2 种不同压力
  let crossTalk = false;
  for (const vs of rootValues.values()) if (vs.size > 1) { crossTalk = true; break; }

  // 漏气：有压分量的未接线可见端子（开口 → 漏向大气）
  const leaks = [];
  for (const i of G.panel.instances.values()) {
    for (const t of i.terminals) {
      if (t.type !== 'pneumatic' || t.isHidden) continue;
      if (t.connections.length > 0) continue;   // 已接管 → 不是开口
      if ((pressure.get(graph.find(t)) || 0) > 0) leaks.push(t);
    }
  }

  const pressureOf = term => {
    if (!term || term.type !== 'pneumatic') return 0;
    return pressure.get(graph.find(term)) || 0;
  };

  return { graph, pressure, crossTalk, leaks, pressureOf };
}

/** 端子是否带压（与任一有压分量连通）——禁止带压接线/拔管；不含故障（绝对安全语义） */
export function isTerminalPressurized(term) {
  if (!term || term.type !== 'pneumatic') return false;
  const pn = computePneumatics();
  return pn.pressureOf(term) > 0;
}
