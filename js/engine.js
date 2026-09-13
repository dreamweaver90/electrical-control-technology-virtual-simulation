/**
 * 虚拟接线仿真系统 — 仿真引擎
 *
 * SimulationEngine: PLC 周期扫描，短路检测与保护
 * UnionFind / buildGraph 见 graph.js（连通图统一构建模块）
 */

import { G } from './globals.js';
import { buildGraph } from './graph.js';
import { solveNetwork } from './solver.js';
import { computePneumatics } from './pneumatic.js';

/* ================================================================
   仿真引擎
   ================================================================ */
export class SimulationEngine {
  constructor() {
    this._timer  = null;
    this.shorted = false;   // 当前是否短路（防止重复弹窗）
    this._leakMarked = new Map();   // 漏气端子标记缓存（instanceId.termId → dotEl）
    this._shortTripAt = null;       // 最近一次"短路跳闸"发生时刻（告警 3 秒后消失）
    this._tickCount = 0;           // 电气仿真时间基准（tick 计数 × 名义周期；后台节流不失真）
  }

  /** 启动周期扫描 */
  start() {
    if (this._timer) return;
    const interval = G.config.simulation.refreshIntervalMs || 50;
    this._timer = setInterval(() => this._tick(), interval);
  }

  /** 停止扫描 */
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /**
   * 单次 PLC 扫描（每次只执行一遍，状态在下个周期生效）。
   *
   * 算法流程：
   * ① 构建 G_loadfree——导线+闭合触点是边，线圈/绕组不是边。
   *    使用上一周期 scan() 设定的触点状态。
   * ② 短路检测——G_loadfree中L和N在同一分量=不经负载的纯导体路径→短路。
   *    逐个排除断路器重构图；若短路消失则该断路器在路径上→断开它。
   * ③ 电位映射——连通分量→包含哪些电源端子(L1/L2/L3/N)。
   * ④ 扫描器件——接触器判定吸合、电动机判定接法+相序（线圈断路/绕组断路
   *    故障标记由器件 scan 自管，从 G.faultManager 同步）。
   *    状态变化（如触点切换）在下个 tick 的 G_loadfree 中才生效。
   */
  _tick() {
    try {
      const panel = G.panel;
      const wm    = G.wiring;
      if (!panel || !wm) return;

      this._tickCount++;
      // 电气时序仿真时间（tick 计数 × 名义周期；与 start() 的 setInterval、电机积分的 dt 同读
      // 主配置 simulation.refreshIntervalMs——改周期三处一致，不出现两套时钟。机械积分/UI 告警计时用墙钟）
      const tickMs = this._tickCount * (G.config.simulation.refreshIntervalMs || 50);
      const prevSolve = G.solveResult;       // 上一 tick 求解结果（跳闸判定消费，单次扫描不迭代）

      // 找全部电源实例（power 能力识别，与 class/type 无关）
      const powerInsts = [];
      for (const i of panel.instances.values()) {
        if (i.hasCapability && i.hasCapability('power')) powerInsts.push(i);
      }

      // ① 构建 G_loadfree（导线 + 闭合触点 + 故障注入，统一走 graph.js）
      const graph = buildGraph();
      // ② 短路检测与保护：返回 {shortInsts（短路电源集合）, tripped（是否跳闸）}
      //    跳闸电流判定消费上一 tick 求解结果——短路持续/无新跳闸的 tick 不再重复求解
      const shortRes = powerInsts.length
        ? this._detectShort(graph, powerInsts, prevSolve)
        : { shortInsts: new Set(), tripped: false };
      const shortInsts = shortRes.shortInsts;
      const shorting = shortInsts.size > 0;
      if (shortRes.tripped) this._shortTripAt = Date.now();   // 跳闸 → 3 秒告警计时
      // 电源短路标记：只在短路发生时回调 onShortCircuit(true)（恢复时不回调——熔断保护语义：
      // 短路后电源断电锁死（short_circuit 保持 true），由保险丝 zones 手动复位；
      // 若短路物理上仍存在则下个 tick 再次熔断）。快照照常更新，保证下次短路能触发沿。
      for (const ps of powerInsts) {
        const v = shorting && shortInsts.has(ps);
        if (ps._scLast !== v) {
          ps._scLast = v;
          if (v) ps.onShortCircuit(v);
        }
      }

      // ④ 数值层求解：MNA 相量求解（AC/DC 岛分离、电源内阻限流、双层阻抗支路）
      //    结果挂 G.solveResult：节点电位 + 全部支路电流（一次求解，O(支路数)）
      const solve = solveNetwork(powerInsts);
      G.solveResult = solve;

      // ⑤ 扫描每个器件（线圈得电/整流器输入/热继电器过载/电机绕组电压读 solve）
      //    逐器件容错：单个器件抛错不拖垮本 tick 剩余 scan/气路段/告警栈/万用表刷新。
      //    返回 true = 状态有变化 → 引擎集中 refreshDisplay（消除"改状态忘刷新"类 bug 的土壤）
      for (const i of panel.instances.values()) {
        try {
          if (i.scan(graph, { solve, tickMs }) && typeof i.refreshDisplay === 'function') i.refreshDisplay();
        }
        catch (e) { console.error('器件扫描异常 [' + (i.definition && i.definition.id || '?') + ']:', e); }
      }

      // ⑥ 气路段：气路连通图 + 气压传播（压力源注入/串气判定/漏气检测）
      //    在电气 scan 之后执行——电磁阀线圈判定（读 solve）已更新阀位，
      //    气路图按新阀位构建；气路执行器（气缸/调压阀/电磁阀位置机）读气压。
      let pn = null;
      try {
        pn = computePneumatics();
        G.pneumatics = pn;
        for (const i of panel.instances.values()) {
          if (!i.scanPneumatic) continue;
          try { i.scanPneumatic(pn); }
          catch (e) { console.error('气路器件扫描异常 [' + (i.definition && i.definition.id || '?') + ']:', e); }
        }
      } catch (e) { console.error('气路仿真异常:', e); }

      // ⑦ 统一告警栈：短路（跳闸 3 秒 / 无保护常驻）+ 串气 + 漏气 + 双线圈冲突
      const alerts = [];
      if (this._shortTripAt && Date.now() - this._shortTripAt < 3000) {
        alerts.push({ key: 'short_trip', icon: '⚠', text: '短路！断路器跳闸', bg: '#e67e22' });
      } else if (shorting) {
        alerts.push({ key: 'short_noprot', icon: '⚠', text: '短路！无断路器保护', bg: '#e74c3c' });
      }
      if (pn) {
        if (pn.crossTalk) alerts.push({ key: 'cross_talk', icon: '⚠', text: '串气！不同气压气源直接连通', bg: '#8e44ad' });
        if (pn.leaks.length) {
          const names = pn.leaks.slice(0, 3).map(t => t.parentInst.displayName() + '.' + (t.tip || t.id)).join('、');
          alerts.push({ key: 'leak', icon: '💨', text: '漏气！' + names + (pn.leaks.length > 3 ? ' 等 ' + pn.leaks.length + ' 处' : ''), bg: '#c0392b' });
        }
        this._syncLeakMarks(pn);   // 漏气端子 💥 标记（视觉，独立于告警栈）
      }
      for (const i of panel.instances.values()) {
        if (typeof i.collectAlerts !== 'function') continue;
        try { alerts.push(...i.collectAlerts()); }
        catch (e) { console.error('器件告警收集异常 [' + (i.definition && i.definition.id || '?') + ']:', e); }
      }
      this._updateAlerts(alerts);

      // 万用表同步刷新
      if (G.app && G.app.multimeter && G.app.multimeter.active) G.app.multimeter._refresh();
    } catch(e) { console.error('仿真引擎异常:', e); }
  }

  /* ---- 气路漏气端子标记（视觉） ---- */

  /** 漏气端子 💥 标记增量同步（恢复自动消失；文字提示走统一告警栈） */
  _syncLeakMarks(pn) {
    const leakKeys = new Set(pn.leaks.map(t => t.parentInst.instanceId + '.' + t.id));
    for (const [k, dot] of this._leakMarked) {
      if (!leakKeys.has(k) || !dot.isConnected) { dot.classList.remove('leak'); this._leakMarked.delete(k); }
    }
    for (const t of pn.leaks) {
      const k = t.parentInst.instanceId + '.' + t.id;
      if (t.dotEl && !this._leakMarked.has(k)) { t.dotEl.classList.add('leak'); this._leakMarked.set(k, t.dotEl); }
    }
  }

  /* ---- 统一告警栈（短路/串气/漏气/双线圈冲突，全部提示的列表） ---- */

  /**
   * 按 key 增量 diff 更新告警列表 DOM（值不变不写）：
   *   {key, icon, text, bg} —— key 全局唯一；消失的移除、新增的追加、文字变化才更新。
   */
  _updateAlerts(list) {
    const stack = document.getElementById('alertStack');
    if (!stack) return;
    const keys = new Set(list.map(a => a.key));
    for (const el of [...stack.children]) {
      if (!keys.has(el.dataset.key)) el.remove();
    }
    const byKey = new Map([...stack.children].map(el => [el.dataset.key, el]));
    for (const a of list) {
      let el = byKey.get(a.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'alert-item';
        el.dataset.key = a.key;
        el.style.background = a.bg || '#c0392b';
        stack.appendChild(el);
      }
      const t = a.icon + ' ' + a.text;
      if (el.textContent !== t) el.textContent = t;
    }
    stack.style.display = list.length ? 'flex' : 'none';
  }

  /* ---- 短路检测 ---- */

  /**
   * 检测短路，并让承载短路的断路器跳闸。
   * 短路判定（严格）：含 ≥2 个 working 电源输出端子的连通分量 = 短路
   *   （任意两源端子同分量即源间纯导体直通，AC/DC 混接、电源并联均判，无共地例外）。
   * 跳闸判定（数值层电流）：闭合断路器触头支路电流 > rules.tripCurrent（短路电流由源内阻限流，
   *   可达数千 A；正常支路电流仅 A 级）→ 跳闸——覆盖并联/分叉支路各自短路、且正常支路断路器不误跳。
   *   ★ 电流判定消费上一 tick 求解结果（@param prevSolve）：单次扫描不迭代，短路持续/无新跳闸的
   *     tick 不再重复求解；跳闸反应滞后 1 tick（50ms），与触点 when 求值的滞后惯例一致。
   *   混域短路（AC×DC，solveNetwork 跳过）无电流 → 退回结构层"触点两端在同一短路分量"（唯一路径可识别）。
   * @param {UnionFind} graph 本 tick 结构图
   * @param {ComponentInstance[]} powerInsts
   * @param {SolveResult|null} prevSolve 上一 tick 求解结果（首 tick 为 null → 本 tick 不判跳闸）
   * @returns {{shortInsts: Set, tripped: boolean}} 短路电源集合 + 是否发生跳闸（提示统一走告警栈）
   */
  _detectShort(graph, powerInsts, prevSolve) {
    const panel = G.panel;
    const shortedInsts = new Set();
    const mark = s => shortedInsts.add(s.ps);

    // 收集全部有效源端子（working 电源的输出端子）
    const srcs = [];
    for (const ps of powerInsts) {
      if (!ps.working) continue;   // ★ 断电电源输出被短接不算短路
      for (const t of ps.outputTerminals()) srcs.push({ t, ps });
    }
    // 短路分量：含 ≥2 个源端子的连通分量（任意两源端子同分量 = 短路）
    const rootToSrcs = new Map();
    for (const s of srcs) {
      const r = graph.find(s.t);
      if (!rootToSrcs.has(r)) rootToSrcs.set(r, []);
      rootToSrcs.get(r).push(s);
    }
    const shortRoots = new Set();
    for (const [r, list] of rootToSrcs) {
      if (list.length >= 2) { shortRoots.add(r); for (const s of list) mark(s); }
    }
    if (shortRoots.size === 0) return { shortInsts: shortedInsts, tripped: false };

    // 跳闸：数值层电流判定（消费上一 tick 求解结果；同域短路岛可解，源内阻限流 → 触头电流巨大；
    //       正常支路电流小）。prevSolve=null（首 tick）→ 不判，本 tick 求解后下 tick 生效
    const solve = prevSolve || null;
    const th = (G.config.rules && G.config.rules.tripCurrent) || 100;   // 短路电流阈值（A）
    let tripped = false;
    for (const i of panel.instances.values()) {
      if (!i.hasCapability || !i.hasCapability('trip') || !i.params.switch) continue;
      let onPath = false, currentChecked = false;
      if (solve) {
        // 触点数值支路统一由 numericBranches() 产出（内部已判：有电阻 && 闭合 && 无故障），
        // 短路电流判定只扫 contact: 支路 —— 引擎不再重复"触点电阻"语义
        for (const b of i.numericBranches()) {
          if (!b.key || !b.key.startsWith('contact:')) continue;
          const cur = solve.currentOf(i, b.key);
          if (cur) { currentChecked = true; if (Math.hypot(cur.re, cur.im) > th) { onPath = true; break; } }
        }
      }
      // 仅混域短路（同域求解不出电流，currentOf 全 null）时退回结构层：
      // 触点两端在同一短路分量（唯一路径时可识别）；同域短路电流可读则完全按电流判定，避免误跳正常支路
      if (solve && !onPath && !currentChecked) {
        for (const [a, b] of i.closedContactPairs()) {
          const ra = graph.find(a), rb = graph.find(b);
          if (ra === rb && shortRoots.has(ra)) { onPath = true; break; }
        }
      }
      if (onPath) {
        i.onShortCircuit(true);   // 回调断路器，由其执行跳闸表现
        tripped = true;
      }
    }

    // 提示统一走告警栈（engine._tick 组装）：跳闸 3 秒 / 无保护常驻
    return { shortInsts: shortedInsts, tripped };
  }
}
