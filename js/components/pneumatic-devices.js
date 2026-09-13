/**
 * 虚拟接线仿真系统 — 气路器件（pneumatic-devices.js）
 *
 * PressureSourceInstance      气源（pressure-source 能力）：带开关 zone，出气端固定气压；
 *                             无开关配置（无 switch 参数键）时 = 恒压气源。
 * PneumaticValveInstance      气路阀（一拖 N：手动气源开关 / 电磁阀 / 阀岛）：
 *                             位置状态机 + 气路触点（pneumatic contacts，when 驱动）配置化。
 * PressureRegulatorInstance   调压阀（pressure-source 能力，动态源）：出气 = min(设定, 进气)，
 *                             指针动画由 params.out_pressure（实际输出）驱动。
 *
 * 气路阀（PneumaticValveInstance）现行格式见本文件下方类注释（def.raw.pneumatic.valves 数组：
 * type/posKeys/coilMap/defaultPosKey/inletPort；单线圈阀不进 valves，触点 when 直接表达）。
 */
import { ComponentInstance } from './component-base.js';
import { judgeCoilEntry } from './coil-judge.js';

/* ================================================================
   气源（pressure-source：恒压源）
   ================================================================ */
export class PressureSourceInstance extends ComponentInstance {
  static capabilities = ['pressure-source'];

  constructor(def, rowIndex) {
    super(def, rowIndex);
    this.working = false;   // pressure-source 能力契约属性（scan 不参与，开关事件驱动）
    const src = def.raw && def.raw.pneumaticSource;
    this._outletIds = (src && Array.isArray(src.outlets)) ? src.outlets : [];
    // 配置了 switch 参数键 = 带开关气源（开关闭合才出气）；无 = 恒压气源
    this._hasSwitch = Object.prototype.hasOwnProperty.call(this.params, 'switch');
    this.working = this._hasSwitch ? !!this.params.switch : true;
  }

  /** 出气端子（pressure-source 契约） */
  outputTerminals() {
    const tm = new Map(this.terminals.map(t => [t.id, t]));
    return this._outletIds.map(id => tm.get(id)).filter(Boolean);
  }

  /** 出气气压 MPa（恒压源：params.pressure，与进气无关；inletP 恒为 null） */
  pressureValue(term, inletP) {
    const v = this.params.pressure;
    return (v && v > 0) ? v : 0;
  }

  /** 开关热区（toggle/on/off/press，与电气开关同构） */
  handleZoneAction(id, action, phase) {
    switch (action) {
      case 'toggle': this.params.switch = !this.params.switch; break;
      case 'on':     if (phase === 'down') this.params.switch = true;  break;
      case 'off':    if (phase === 'down') this.params.switch = false; break;
      case 'press':  this.params.switch = phase === 'down';            break;
    }
    if (this._hasSwitch) this.working = !!this.params.switch;
    this.refreshDisplay();
  }

  /** 参数面板写回（压力值变化）：working 与开关状态重新同步 */
  onParamsChanged() {
    if (this._hasSwitch) this.working = !!this.params.switch;
  }
}

/* ================================================================
   气路电磁阀（双线圈阀位置机）
   ================================================================ */

/**
 * 电磁阀（PneumaticValveInstance）——仅处理双线圈阀单元（def.raw.pneumatic.valves 数组）。
 * 单线圈阀（两位三通/两位五通单控）不进 valves：线圈 = electrical loads（state 键），
 * 气路切换 = pneumatic contacts `when:"线圈state键"`/`when:"!state键"` 直接表达（弹簧复位不校验气压）。
 *
 * valves 单元字段：
 *   type           "5_2_double"（三位五通 "5_3" 预留后加）
 *   posKeys        [位置键...] 显式声明，当前激活位 true
 *   coilMap        {线圈loads条目key: 位置键}（该线圈得电的目标位）
 *   defaultPosKey  复位位（冲突态且都失电时：进气有压 → 回此位；进气无压 → 保持冲突）
 *   inletPort      进气端子 id（先导式语义：有效触发 = 线圈得电 ∧ 进气有压）
 *
 * 双线圈状态机（气路段 scanPneumatic，pIn = inletPort 气压，E = 有效线圈目标位集合）：
 *   E 空 ∧ 非冲突态        → 保持（双电控记忆）
 *   E 空 ∧ 冲突态          → pIn>0 回 defaultPosKey / pIn==0 保持冲突
 *   E 单元素               → 置该位（自然退出冲突）
 *   E 双元素               → 双位同时激活 + 冲突标记（引擎收集进告警栈提示）
 */
export class PneumaticValveInstance extends ComponentInstance {
  constructor(def, rowIndex) {
    super(def, rowIndex);
    this._valveUnits = [];
    this._coilEnergized = new Map();   // loads 条目 key → 得电状态（scan 写入，scanPneumatic 消费）
    this._conflict = false;            // 双线圈冲突标记（scanPneumatic 写入，collectAlerts 汇报）
    const list = def.raw && def.raw.pneumatic && Array.isArray(def.raw.pneumatic.valves)
      ? def.raw.pneumatic.valves : [];
    for (const u of list) {
      this._valveUnits.push({
        type: u.type || '5_2_double',
        posKeys: Array.isArray(u.posKeys) ? u.posKeys : [],
        coilMap: (u.coilMap && typeof u.coilMap === 'object') ? u.coilMap : {},
        defaultPosKey: u.defaultPosKey || null,
        inletTerm: u.inletPort ? this.terminals.find(t => t.id === u.inletPort) : null,
      });
    }
  }

  /**
   * 电气阶段：判定全部线圈得电并写 loads.state 键——
   * 单线圈阀的触点 when 直接引用这些键；双线圈单元的位置机在气路段读 _coilEnergized。
   */
  scan(G, ctx) {
    super.scan(G, ctx);   // 基类：when/timing 触点求值（用上一 tick 的位置键）
    let changed = false;
    for (const e of this.pairEntries.loads) {
      if (e.computed) continue;
      const en = judgeCoilEntry(this, e, ctx);   // 断路强制失电 / 数值层滞回判定（共享模块，与接触器同一套逻辑）
      if (this._coilEnergized.get(e.key) !== en) {
        this._coilEnergized.set(e.key, en);
        changed = true;
      }
      // 单线圈阀/得电指示的状态键（loads 条目 state 字段配置的才写）
      if (e.state && this.params[e.state] !== en) { this.params[e.state] = en; changed = true; }
    }
    return changed;   // engine 按返回值集中 refreshDisplay
  }

  /** 气路段：双线圈单元位置状态机（需 inletPort 气压，与气缸/调压阀同一阶段） */
  scanPneumatic(pn) {
    if (!this._valveUnits.length) return;
    let anyConflict = false;
    let changed = false;
    for (const u of this._valveUnits) {
      const pIn = u.inletTerm ? pn.pressureOf(u.inletTerm) : 0;
      // 有效触发集：线圈得电 ∧ 进气有压
      const active = [];
      for (const [coilKey, posKey] of Object.entries(u.coilMap)) {
        if (this._coilEnergized.get(coilKey) && pIn > 0) active.push(posKey);
      }
      const cur = u.posKeys.filter(k => !!this.params[k]);   // 当前激活位
      let next = null;   // null = 保持
      if (active.length === 0) {
        // 冲突态（双位激活）且都失电：进气有压回默认位 / 无压保持冲突
        if (cur.length >= 2 && pIn > 0) next = u.defaultPosKey ? [u.defaultPosKey] : [];
      } else if (active.length === 1) {
        next = [active[0]];                     // 单有效 → 置位（自然退出冲突）
      } else {
        next = active;                          // 双有效 → 双位同时激活（异常工况）
      }
      if (next !== null) {
        for (const k of u.posKeys) {
          const v = next.includes(k);
          if (this.params[k] !== v) { this.params[k] = v; changed = true; }
        }
      }
      const conflictNow = u.posKeys.filter(k => !!this.params[k]).length >= 2;
      anyConflict = anyConflict || conflictNow;
    }
    this._conflict = anyConflict;
    if (changed) this.refreshDisplay();
  }

  /** 器件级告警：双线圈同时得电（引擎统一告警栈汇总，基类 collectAlerts 钩子） */
  collectAlerts() {
    return this._conflict
      ? [{ key: 'conflict_' + this.instanceId, icon: '⚡', text: '双线圈同时得电！' + this.displayName(), bg: '#b8860b' }]
      : [];
  }
}

/* ================================================================
   调压阀（pressure-source：动态源，出气 = min(设定, 进气)）
   ================================================================ */
export class PressureRegulatorInstance extends ComponentInstance {
  static capabilities = ['pressure-source'];

  constructor(def, rowIndex) {
    super(def, rowIndex);
    this.working = true;   // 调压阀恒"工作"：有进气即调压输出，无进气输出 0
    const reg = def.raw && def.raw.regulator;
    this._inId = reg && reg.in ? reg.in : null;
    this._inTerm = this._inId ? this.terminals.find(t => t.id === this._inId) : null;
    // 出气端：配置固定为数组 `out: [端子id...]`（多出气端共用一个调压输出，各端等压）
    const outs = (reg && Array.isArray(reg.out)) ? reg.out : [];
    this._outTerms = outs.map(id => this.terminals.find(t => t.id === id)).filter(Boolean);
  }

  /** 出气端子（pressure-source 契约）：全部出气端（可多个，等压） */
  outputTerminals() { return this._outTerms; }

  /** 进气分量气压（computePneumatics 迭代中回调） */
  inletPressure(graph, pressure) {
    if (!this._inTerm) return 0;
    return pressure.get(graph.find(this._inTerm)) || 0;
  }

  /** 出气气压：min(设定, 进气)。inletP=null（首轮未定）→ 0（不注入） */
  pressureValue(term, inletP) {
    const set = this.params.setPressure;
    const s = (set && set > 0) ? set : 0;
    if (inletP == null) return 0;
    return Math.min(s, inletP);
  }

  /** 气路段扫描：写实际输出压力（指针动画/显示文本驱动键；多出气端等压，取第一个） */
  scanPneumatic(pn) {
    const out = pn.pressureOf(this._outTerms[0]);
    const cur = this.params.out_pressure;
    if (cur == null || Math.abs(cur - out) > 1e-9) {
      this.params.out_pressure = out;
      this.refreshDisplay();
    }
    // 指针显示实际输出；设定值另有 display 文本（params.setPressure）
  }
}
