/**
 * 虚拟接线仿真系统 — 图构建公共模块
 *
 * 所有"连通图"（并查集）构建统一收敛到这里：
 *   buildGraph(opts)      导线 + 闭合触点 + 恒连（permanent/sensors），可选 loads 当导体（带电检测）
 *   powerTerminals()      全部 working 电源输出端子（power 能力识别）
 *   isTerminalLive(term)  端子带电检测（loads 当导体、不含故障，绝对安全语义）
 *
 * 四类端子对在结构层的合并规则（蓝图 §1）：
 *   contacts   闭合时合并（closedContactPairs，含 when 时序求值；open 故障断开、stuck 故障粘连）
 *   permanent  恒合并（open 故障断开）
 *   sensors    恒合并（如导线，串联测电流；open 故障断开）
 *   loads      主图不合并（负载自由）；includeCoils 时合并（带电检测/G_cond）
 */
import { G } from './globals.js';

/* ================================================================
   并查集（路径压缩 + 按大小合并，防止退化成深链）
   ================================================================ */
export class UnionFind {
  constructor() { this.p = new Map(); this.sz = new Map(); }

  find(x) {
    if (!this.p.has(x)) { this.p.set(x, x); this.sz.set(x, 1); return x; }
    let r = this.p.get(x);
    if (r !== x) { r = this.find(r); this.p.set(x, r); }
    return r;
  }

  union(a, b) {
    let ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if ((this.sz.get(ra) || 1) < (this.sz.get(rb) || 1)) { const t = ra; ra = rb; rb = t; }
    this.p.set(rb, ra);
    this.sz.set(ra, (this.sz.get(ra) || 1) + (this.sz.get(rb) || 1));
  }
}

/** 端子对全局唯一键（数值支路对标记用；端子 id 在器件内唯一，实例 id 全局唯一） */
export function pairKeyOf(a, b) {
  const ka = a.parentInst.instanceId + '|' + a.id;
  const kb = b.parentInst.instanceId + '|' + b.id;
  return ka < kb ? ka + '||' + kb : kb + '||' + ka;
}

/* ================================================================
   图构建
   ================================================================ */

/**
 * 构建连通图（并查集）。
 * 带模块级缓存：按 opts 变体（media/includeCoils/includeFaults）+ 结构版本号复用——
 * 引擎主图、带电检测图、万用表欧姆档同变体共享，稳态每 tick 零重建；
 * 结构变化（导线增删/触点状态切换/故障注入变化）必须调 invalidateGraphCache() 失效。
 * branchPairKeys 变体（数值层求解用，每 tick 集合不同）不缓存。
 *
 * @param {Object} opts
 * @param {boolean} [opts.includeCoils=false]  loads（阻抗负载）也作为导体合并（带电检测）
 * @param {boolean} [opts.includeFaults=true]  应用故障注入（断线/断路/粘连）
 * @param {Set<string>|null} [opts.branchPairKeys=null]  数值层支路端子对（pairKeyOf 键）：不合并、
 *                                                    保留为数值支路（电流表分流/断路器触头/热元件等）
 * @param {string} [opts.media='electrical']  介质过滤：只并入该介质的导线与端子对条目
 *                                             （气路图 = media:'pneumatic'；电路图与气路图彻底隔离）
 * @returns {UnionFind}
 */
export function buildGraph(opts = {}) {
  const branchPairKeys = opts.branchPairKeys;
  if (!branchPairKeys) {
    const key = (opts.media || 'electrical') + '|' + (opts.includeCoils ? 1 : 0) + '|' + (opts.includeFaults === false ? 0 : 1);
    if (_graphCache && _graphCache.key === key && _graphCache.version === _graphVersion) {
      return _graphCache.g;
    }
    const g = buildGraphInner(opts);
    _graphCache = { key, version: _graphVersion, g };
    return g;
  }
  return buildGraphInner(opts);
}

/** 结构版本号：导线增删/触点状态切换/故障注入变化时自增（缓存失效） */
let _graphVersion = 0;
let _graphCache = null;   // { key, version, g }

/** 图结构失效通知（缓存下 tick 重建）：wiring-manager 导线增删、基类触点时序切换、fault-manager 故障注入变化时调用 */
export function invalidateGraphCache() { _graphVersion++; }

function buildGraphInner(opts) {
  const {
    includeCoils = false,
    includeFaults = true,
    branchPairKeys = null,
    media = 'electrical',
  } = opts;

  const g = new UnionFind();
  const wm = G.wiring, pn = G.panel;
  const fm = includeFaults ? G.faultManager : null;
  if (!wm || !pn) return g;

  const skipBranch = (a, b) => !!(branchPairKeys && branchPairKeys.has(pairKeyOf(a, b)));

  // 导线（断路故障跳过；按介质过滤——气路图只并气路气管）
  for (const w of wm.wires.values()) {
    if ((w.media || 'electrical') !== media) continue;
    if (fm && fm.isWireBroken(w.id)) continue;
    g.union(w.t1, w.t2);
  }

  for (const inst of pn.instances.values()) {

    // 故障修正（open=断开 exclude / stuck=粘连 add），mod 只取一次
    const mod = fm ? fm.getFaultModifications(inst) : { exclude: [], add: [] };
    const isEx = ([a, b]) =>
      mod.exclude.some(p => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a));

    // 闭合触点（closedContactPairs：when 时序求值 + 子类追加；按端子介质过滤）
    for (const [a, b] of inst.closedContactPairs()) {
      if (a.type !== media || b.type !== media) continue;
      if (isEx([a, b])) continue;
      if (skipBranch(a, b)) continue;
      g.union(a, b);
    }
    // 粘连故障强制导通
    for (const [a, b] of mod.add) {
      if (a.type !== media || b.type !== media) continue;
      if (skipBranch(a, b)) continue;
      g.union(a, b);
    }

    // 恒连端子对：permanent + sensors（如导线；open 故障断开）
    for (const [a, b] of [...inst.permanentPairs(), ...inst.sensorPairs()]) {
      if (a.type !== media || b.type !== media) continue;
      if (isEx([a, b])) continue;
      if (skipBranch(a, b)) continue;
      g.union(a, b);
    }

    // 带电检测：loads 当导体（open 故障的对跳过——includeFaults:false 时 fm=null 不过滤，保守判定带电）
    if (includeCoils) {
      for (const e of inst.pairEntries.loads) {
        if (e.media !== media) continue;
        for (let i = 0; i < e.pairs.length; i++) {
          if (fm && fm.isEntryOpen(inst, 'loads', e.key, i)) continue;   // 对级断路：仅故障对不合并
          g.union(e.pairs[i][0], e.pairs[i][1]);
        }
      }
    }
  }
  return g;
}

/* ================================================================
   电源源端子 & 带电检测
   ================================================================ */

/**
 * 全部"当前有效"的电源源端子：power 能力 && working && sourceEmf(term)≠null
 * （= source 配置里定义了 EMF 的端子，如 AC 的 phases[].pin、DC 的 pins 键）。
 * 与求解器源注册同判据——带电检测/短路检测/电位映射/数值求解四处语义一致。
 * 断电电源不参与（输出被短接不算短路、不算带电）。
 * @returns {Terminal[]}
 */
export function powerTerminals() {
  const out = [];
  for (const i of G.panel.instances.values()) {
    if (!i.hasCapability || !i.hasCapability('power') || !i.working) continue;
    for (const t of i.outputTerminals()) out.push(t);
  }
  return out;
}

/**
 * 端子是否与任一有效电源端子连通。
 * 注意：不含故障注入——带电检测用于"禁止带电接线/测量"，有故障也一律按带电处理（绝对安全）。
 */
export function isTerminalLive(term) {
  const graph = buildGraph({ includeCoils: true, includeFaults: false });
  const root = graph.find(term);
  for (const pt of powerTerminals()) {
    if (graph.find(pt) === root) return true;
  }
  return false;
}
