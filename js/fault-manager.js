/**
 * 虚拟接线仿真系统 — 故障管理器（配置驱动，蓝图 §2）
 *
 * 候选收集完全由配置驱动（四类端子对条目的 fault 配置 + 端子 faultLevel）：
 *   fault.level 数值等级：0 = 所有档位可设（默认）；1 = 中等及以上档；大值（10/100）= 不设故障
 *   难度筛选：选中 faultLevels 第 i 档（现 "简单"/"中等"/"困难"）→ 候选 level ≤ i（档数越多等级分得越细）
 *   fault.types 白名单：open = 断路类、stuck = 粘连类（stuck 仅 contacts 条目）
 *   导线故障等级 = 两端端子 faultLevel 更严格者（数值更大者；默认 0；大值排除），只有断路
 * 故障注入统一走 getFaultModifications（exclude=断开 / add=粘连）+ isEntryOpen（条目断路）。
 */
import { G } from './globals.js';
import { invalidateGraphCache } from './graph.js';   // 故障注入变化 → 连通图缓存失效

const FaultType = { WIRE_BREAK: 'wire_break', ENTRY_OPEN: 'entry_open', ENTRY_STUCK: 'entry_stuck' };

export class FaultManager {
  constructor() { this.activeFault = null; this.mode = false; this.attempts = 0; }

  /** 收集候选（maxLevel = 难度等级阈值，即主配置 faultLevels 数组下标：0=最简单，越大越难；level ≤ maxLevel 才候选） */
  collectCandidates(maxLevel = 0) {
    const list = [], panel = G.panel, wm = G.wiring;
    if (!panel || !wm) return list;

    // 导线断路：等级 = 两端端子 faultLevel 更严格者（数值更大者；默认 0；大值排除）
    // ★ 气路永不设故障：跳过气管（只候选电路导线）
    for (const w of wm.wires.values()) {
      if ((w.media || 'electrical') !== 'electrical') continue;
      const lv = Math.max(w.t1.faultLevel !== undefined ? w.t1.faultLevel : 0,
                          w.t2.faultLevel !== undefined ? w.t2.faultLevel : 0);
      if (lv > maxLevel) continue;
      list.push({
        type: FaultType.WIRE_BREAK, wireId: w.id,
        label: w.t1.parentInst.displayName() + '.' + (w.t1.tip || w.t1.id) + ' — ' + w.t2.parentInst.displayName() + '.' + (w.t2.tip || w.t2.id),
        terminalIds: [],
      });
    }

    // 四类端子对条目故障（按配置 fault 筛选）；★ 跳过气路介质（气路永远不设故障，仅电路候选）
    for (const inst of panel.instances.values()) {
      if (inst.hasCapability && inst.hasCapability('power')) continue;   // 电源不参与故障候选
      for (const cat of ['contacts', 'loads', 'permanent', 'sensors']) {
        for (const e of inst.pairEntries[cat]) {
          if (e.media !== 'electrical') continue;   // 气路介质排除（pneumatic 条目无故障语义）
          if (e.fault.level > maxLevel) continue;   // 超过阈值 = 该模式不设此故障
          const types = e.fault.types || [];
          const catName = { contacts: '触点', loads: '负载', permanent: '恒连', sensors: '传感器' }[cat];
          for (let i = 0; i < e.pairs.length; i++) {
            const [a, b] = e.pairs[i];
            if (!a.isConnected() || !b.isConnected()) continue;   // 已接线才候选
            const ids = [a, b].filter(t => !t.isHidden && t.connectLimit !== 0)
              .map(t => inst.instanceId + '.' + t.id);
            const base = { instanceId: inst.instanceId, category: cat, entryKey: e.key, pairIndex: i, terminalIds: ids };
            if (types.includes('open')) {
              list.push({ ...base, type: FaultType.ENTRY_OPEN, label: inst.displayName() + ' ' + catName + '[' + e.key + '#' + (i + 1) + '] 断路' });
            }
            if (cat === 'contacts' && types.includes('stuck')) {
              list.push({ ...base, type: FaultType.ENTRY_STUCK, label: inst.displayName() + ' 触点[' + e.key + '#' + (i + 1) + '] 粘连' });
            }
          }
        }
      }
    }
    return list;
  }

  setRandomFault(maxLevel = 0) {
    const c = this.collectCandidates(maxLevel);
    if (!c.length) return null;
    this.activeFault = c[Math.floor(Math.random() * c.length)];
    this.mode = true; this.attempts = 0;
    invalidateGraphCache();
    return this.activeFault.label;
  }

  clearFault() { this.activeFault = null; this.mode = false; this.attempts = 0; invalidateGraphCache(); }

  /** 排故成功：清除故障注入（电路恢复）但保持排故模式——窗口不自动关闭，用户点退出才结束 */
  resolveFault() { this.activeFault = null; this.attempts = 0; invalidateGraphCache(); }

  /** 用户诊断：传入选中的 wireId 或 terminalId */
  checkDiagnosis(wireId, terminalId) {
    if (!this.activeFault) return { correct: false, msg: '没有设置故障' };
    const f = this.activeFault; this.attempts++;
    let match = false;
    if (f.wireId && wireId === f.wireId) match = true;
    if (f.terminalIds && f.terminalIds.includes(terminalId)) match = true;
    if (match) return { correct: true, msg: '✅ 正确！故障: ' + f.label + '（排查' + this.attempts + '次）' };
    return { correct: false, msg: '❌ 不对，请继续（第' + this.attempts + '次尝试）' };
  }

  isWireBroken(wireId) { return !!(this.activeFault && this.activeFault.type === FaultType.WIRE_BREAK && this.activeFault.wireId === wireId); }

  /**
   * 条目断路故障查询。
   * pairIndex 缺省 = 条目语义：该条目是否含当前注入的断路对（器件级"负载整体失效"
   * 双保险判定用——线圈强制失电/电机停转等）；传入 pairIndex = 对级语义：仅当故障
   * 注入的就是该对才为 true（图合并/数值支路按对跳过用，与候选粒度一致）。
   */
  isEntryOpen(inst, category, entryKey, pairIndex) {
    const f = this.activeFault;
    if (!(f && f.type === FaultType.ENTRY_OPEN && f.instanceId === inst.instanceId &&
          f.category === category && f.entryKey === entryKey)) return false;
    return pairIndex === undefined || f.pairIndex === pairIndex;
  }

  /**
   * 故障注入修正：{exclude, add}
   *   open → 该对断开（exclude，按 pairIndex 对级——候选按"对"生成，注入同粒度；
   *          多对条目不再"设一对断整条目"）；stuck（仅 contacts）→ 该对粘连（add）
   */
  getFaultModifications(inst) {
    const ex = [], ad = [];
    const f = this.activeFault;
    if (!f || f.instanceId !== inst.instanceId || !f.category) return { exclude: ex, add: ad };
    const entry = inst.pairEntries[f.category].find(e => e.key === f.entryKey);
    if (!entry || f.pairIndex >= entry.pairs.length) return { exclude: ex, add: ad };
    if (f.type === FaultType.ENTRY_OPEN) {
      ex.push(entry.pairs[f.pairIndex]);
    } else if (f.type === FaultType.ENTRY_STUCK && f.category === 'contacts') {
      ad.push(entry.pairs[f.pairIndex]);
    }
    return { exclude: ex, add: ad };
  }
}
