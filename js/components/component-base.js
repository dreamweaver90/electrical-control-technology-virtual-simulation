/**
 * 虚拟接线仿真系统 — 器件实例基类（component-base.js）
 *
 * ComponentInstance：通用 DOM（卡片/图像层/端子圆点）、拖动、触点配对、
 * 四类端子对条目（contacts/loads/permanent/sensors）、when/timing 触点时序求值器、
 * 数值支路通用实现、能力检查（hasCapability）。
 * 各器件子类拆分到独立文件，统一经 components.js 聚合导出。
 */
import { Terminal } from '../terminal.js';
// 全局单例用别名 GS：scan(G, ctx) 的参数 G 是并查集，会遮蔽模块级 G（GS.faultManager 等）
import { G as GS } from '../globals.js';
import { ParamPanel } from '../param-panel.js';
import { compileExpr } from '../bool-expr.js';   // when/bind 布尔表达式（逻辑运算支持）
import { invalidateGraphCache } from '../graph.js';   // 触点时序切换 → 连通图缓存失效

/* ================================================================
   基类
   ================================================================ */
let _nextId = 0;

export class ComponentInstance {
  constructor(def, rowIndex) {
    this.instanceId = 'inst_' + (++_nextId);
    this.definition = def;          // ComponentDefinition
    this.rowIndex   = rowIndex;
    this.left       = 0;
    this.top        = 0;
    this.el         = null;
    this._imageLayers = null;
    this._animBinds = null;   // 元素动画绑定缓存（createDOM 时按 image 条目 anims 建立）
    this._classBinds = null;  // 元素 class 绑定缓存（image 条目 classBind：参数值 → 标记元素 class）
    this._termMoved = false;  // 本 tick 是否有端子坐标被动画移动（scan 末尾触发导线路径重算）
    this._last      = {};

    // 参数容器（统一承载一切：铭牌定值 + 面板可调项 + 逻辑状态键 + 运行时值）。
    // 显示键（带 images 的 params 条目）初值来自 default（缺省 false），见 defaultParams()。
    this.params = def.defaultParams ? def.defaultParams() : {};

    // 端子实例列表
    this.terminals = def.flattenTerminals().map((td, i) => new Terminal(td, this, i));

    // 四类端子对条目（id 级 → Terminal 引用解析）：
    //   contacts  → 闭合情况由 when/timing 求值器决定；permanent/sensors → 结构层恒连；
    //   loads     → 短路判定图不合并（负载自由）、带电检测图合并、数值层阻抗支路；
    const tmap = new Map(this.terminals.map(t => [t.id, t]));
    this.pairEntries = { contacts: [], loads: [], permanent: [], sensors: [] };
    for (const cat of ['contacts', 'loads', 'permanent', 'sensors']) {
      for (const e of def.pairEntries()[cat]) {
        const pairs = e.pairs
          .map(p => { const a = tmap.get(p.a), b = tmap.get(p.b); return (a && b) ? [a, b] : null; })
          .filter(Boolean);
        const entry = {
          category: cat, key: e.key, pairs,
          media: e.media,   // 介质（electrical/pneumatic）：排故候选按介质过滤（气路永不设故障）
          when: e.when, closeDelay: e.closeDelay, openDelay: e.openDelay,
          resistance: e.resistance, computed: e.computed,
          fault: e.fault,
          // 条目级扩展字段（配置驱动）透传：
          // state（得电状态键）/ tonState / tofState（延时显示键）/ delayForceKey（延时计时动作源的强制信号键，仅计时用不写 state）
          state: e.state, tonState: e.tonState, tofState: e.tofState, delayForceKey: e.delayForceKey,
        };
        this.pairEntries[cat].push(entry);
      }
    }

    // 触点时序状态：when 条目的"实际闭合状态 + 边沿延迟计时"
    this._contactState = new Map();   // entryKey → bool
    this._contactTimer = new Map();   // entryKey → {start, target}
    this._contactTicks = 0;
    for (const e of this.pairEntries.contacts) {
      if (!e.when) continue;
      // 与 _evaluateContacts 同一求值器（compileExpr 支持 && || ! 括号；编译缓存共享）——
      // 旧单键求值对复合 when（如 "!(energized || forced)"）依赖默认全 false 碰巧正确
      if (!e._whenExpr) e._whenExpr = compileExpr(e.when);
      const on = e._whenExpr.fn(this.params);
      this._contactState.set(e.key, !!on);   // 初始即稳定态（无延迟）
    }
  }

  /* ---- 能力协议 ---- */

  /** 能力检查：读类静态声明 capabilities 数组（与继承链无关） */
  hasCapability(name) {
    const caps = this.constructor.capabilities;
    return Array.isArray(caps) && caps.includes(name);
  }

  /* ---- 器件级告警钩子 ---- */

  /**
   * 器件级告警（统一告警栈）：engine 每 tick 汇总全部实例的 collectAlerts()。
   * 返回 [{key(全局唯一), icon?, text, bg?}]；默认无告警。
   * 子类覆写自报报警（如双线圈冲突 / 磁性传感器接交流、超压），引擎零器件特判。
   */
  collectAlerts() {
    return [];
  }

  /* ---- 抽象接口 ---- */

  /** 每个扫描周期调用：G 为结构层并查集，ctx = { solve, tickMs }。
   *  基类实现 = when/timing 触点求值 + 动画刷新（每 tick 无条件，内部值比对稳态零开销）；
   *  动画移动了端子坐标 → 重算全部 auto 导线路径（端子位置变了，导线跟随；manual 保持轨迹）。
   *  子类覆盖时先调 super.scan(G, ctx) */
  scan(G, ctx) {
    this._evaluateContacts();
    this._updateAnims();
    this._updateClasses();
    if (this._termMoved) {
      this._termMoved = false;
      if (GS.panel && GS.panel._refreshAllWirePaths) GS.panel._refreshAllWirePaths(this);   // 只重算本实例连接线
    }
    return false;
  }

  /** 返回当前闭合的触点对 [[Terminal, Terminal], …]。
   *  基类实现 = when 条目的求值结果；无 when 的条目由子类覆盖时用 super() 合并追加 */
  closedContactPairs() {
    const out = [];
    for (const e of this.pairEntries.contacts) {
      if (!e.when) continue;
      if (this._contactState.get(e.key)) for (const [a, b] of e.pairs) out.push([a, b]);
    }
    return out;
  }

  /**
   * 数值层支路（通用实现，子类一般不需要覆盖）：
   *   loads    阻抗支路（computed 钩子或 params.impedance）
   *   sensors  小阻值支路（params.sensorResistance 兜底条目 resistance）
   *   contacts 仅"当前闭合"且有阻值的触头（params.contactResistance 兜底条目 resistance）
   * 阻抗数值统一走 _branchZ()（器件级 params 优先、条目值兜底，消除多来源不一致）；
   * open 故障条目 → 支路移除；无数值支路 = 纯 0Ω 导体不算电流
   */
  numericBranches() {
    const out = [];
    const openF = (cat, key, pairIndex) => this._entryOpenFault(cat, key, pairIndex);
    for (const e of this.pairEntries.loads) {
      const z = this._branchZ('loads', e);
      if (!z) continue;
      const zdc = { re: this._loadDcResistance(z), im: 0 };
      for (let i = 0; i < e.pairs.length; i++) {
        if (openF('loads', e.key, i)) continue;   // 对级断路：只移除故障对支路
        const [a, b] = e.pairs[i];
        out.push({ a, b, z, zdc, key: 'load:' + e.key });
      }
    }
    for (const e of this.pairEntries.sensors) {
      const z = this._branchZ('sensors', e);
      if (!z) continue;
      for (let i = 0; i < e.pairs.length; i++) {
        if (openF('sensors', e.key, i)) continue;
        out.push({ a: e.pairs[i][0], b: e.pairs[i][1], z, key: 'sensor:' + e.key + ':' + i });
      }
    }
    const closed = this.closedContactPairs();
    for (const e of this.pairEntries.contacts) {
      const z = this._branchZ('contacts', e);
      if (!z) continue;
      for (let i = 0; i < e.pairs.length; i++) {
        if (openF('contacts', e.key, i)) continue;
        const [a, b] = e.pairs[i];
        if (!closed.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) continue;
        out.push({ a, b, z, key: 'contact:' + e.key + ':' + i });
      }
    }
    return out;
  }

  /** loads 条目 computed 阻抗钩子（子类覆盖；如电机返回 Z_run/Z_lock） */
  _computedLoadImpedance(key) { return null; }

  /**
   * 条目数值阻抗统一取值入口（数值来源统一为"器件级 params 优先、条目级兜底"）：
   *   loads    → params.impedance（computed 条目 → _computedLoadImpedance 钩子；缺失时 warn 一次）
   *   sensors  → params.sensorResistance 兜底条目 e.resistance（纯阻）
   *   contacts → params.contactResistance 兜底条目 e.resistance（纯阻）
   * 全部缺失 → null（该条目不产出数值支路）
   */
  _branchZ(cat, e) {
    if (e.computed) return this._computedLoadImpedance(e.key);
    if (cat === 'loads') {
      const z = this._loadImpedance();
      if (!z && !this._warnedLoadZ) {
        this._warnedLoadZ = true;   // 只警告一次：loads 缺阻抗 → 回路电流静默为 0，提示配置错误
        console.warn(`[配置] ${this.instanceId}（${this.definition.id}）loads 条目 "${e.key}" 无阻抗：params.impedance 未配置`);
      }
      return z;
    }
    const r = this._paramResistance(cat) || e.resistance;
    return r ? { re: r, im: 0 } : null;
  }

  /** 器件级电阻参数：sensors → params.sensorResistance；contacts → params.contactResistance（>0 生效；未配/≤0 → null） */
  _paramResistance(cat) {
    const v = this.params && this.params[cat === 'sensors' ? 'sensorResistance' : 'contactResistance'];
    return (typeof v === 'number' && v > 0) ? v : null;
  }

  /** loads 条目数值阻抗（AC 岛 z）：统一读 params.impedance——对象 {re,im}（定值）或数字（纯阻性，可面板调）；器件内所有负载生效 */
  _loadImpedance() {
    const z = this.params && this.params.impedance;
    if (z == null) return null;
    if (typeof z === 'number') return { re: z, im: 0 };
    if (typeof z === 'object' && typeof z.re === 'number') return z;
    return null;
  }

  /** loads 条目直流稳态电阻（DC 岛 zdc）：统一读 params.dcResistance（定值或可调）；缺省回退运行阻抗实部 */
  _loadDcResistance(z) {
    const r = this.params && this.params.dcResistance;
    return (r != null && r > 0) ? r : z.re;
  }

  /** 条目 open 故障查询（FaultManager 提供；pairIndex 可选——缺省条目语义，传入则对级语义） */
  _entryOpenFault(category, key, pairIndex) {
    const fm = GS.faultManager;
    return !!(fm && fm.isEntryOpen && fm.isEntryOpen(this, category, key, pairIndex));
  }

  /** 恒连端子对（permanent 条目，永远导通） */
  permanentPairs() {
    const out = [];
    for (const e of this.pairEntries.permanent) for (const p of e.pairs) out.push(p);
    return out;
  }

  /** 电流测量端子对（sensors 条目，结构层恒连如导线） */
  sensorPairs() {
    const out = [];
    for (const e of this.pairEntries.sensors) for (const p of e.pairs) out.push(p);
    return out;
  }

  /** 显示名称：params.name（标牌参数，text）优先；未配置或为空 → 配置 name。排故/告警/绑定/删除确认统一入口 */
  displayName() {
    const n = this.params && this.params.name;
    return (typeof n === 'string' && n.trim()) ? n : this.definition.name;
  }

  /* ---- when/timing 触点时序求值器（每 tick 一次，基类 scan 驱动） ---- */

  _evaluateContacts() {
    this._contactTicks++;
    for (const e of this.pairEntries.contacts) {
      if (!e.when) continue;   // 无 when → 子类 closedContactPairs 自行判定
      if (!e._whenExpr) e._whenExpr = compileExpr(e.when);   // 首次编译缓存（条目对象 per-instance，安全）
      const on = e._whenExpr.fn(this.params);                // 布尔表达式（支持 && || ! 括号，旧单键语法兼容）
      const want = !!on;                       // 目标：闭合
      const cur = !!this._contactState.get(e.key);
      if (want === cur) { this._contactTimer.delete(e.key); continue; }
      const delay = want ? e.closeDelay : e.openDelay;   // 该闭合看 closeDelay、该断开看 openDelay
      if (!delay) { this._contactState.set(e.key, want); this._contactTimer.delete(e.key); invalidateGraphCache(); continue; }
      let t = this._contactTimer.get(e.key);
      if (!t || t.target !== want) t = { start: this._contactTicks, target: want };
      if (this._contactTicks - t.start >= delay) {
        this._contactState.set(e.key, want);
        this._contactTimer.delete(e.key);
        invalidateGraphCache();   // 触点状态切换 → 连通图缓存失效
      } else {
        this._contactTimer.set(e.key, t);
      }
    }
  }

  /* ---- 通用 DOM 构建 ---- */

  /**
   * 创建器件卡片 DOM。
   */
  createDOM() {
    const def  = this.definition;
    const hr   = def.termHitRadius;

    // 卡片容器
    const card = document.createElement('div');
    card.className = 'component-card';
    if (this.hasWires) card.classList.add('wired');
    card.dataset.instanceId = this.instanceId;
    card.draggable = false;
    card.style.left = this.left + 'px';

    // 占位元素：图像层为 absolute（脱离文档流），需占位撑起卡片宽高，
    // 否则卡片坍缩 → 名称错位/拖拽命中异常/行高视觉偏移（与旧 <img> 文档流模型等价）
    // 同时作为端子坐标基准（panelPos 用它换算面板坐标，替代旧 _imgEl）
    const holder = document.createElement('div');
    holder.className = 'comp-img-holder';
    holder.style.cssText =
      'width:'  + (def.size ? def.size.width : 0) + 'px;' +
      'height:' + (def.size ? def.size.height : 0) + 'px;';
    this._holderEl = holder;
    card.appendChild(holder);

    // 图像层：image 数组全部渲染，default 常显在底层，其余隐藏（状态驱动显隐）
    // DOM 顺序即层叠顺序：下标越大越靠上（default 放数组首位 = 底层）
    this._imageLayers = [];
    for (const item of def.imageItems) {
      const layer = document.createElement('div');
      layer.className = 'comp-img-layer';
      // 定位基准与 term-dot 一致：补偿卡片 padding（6/4），保证 SVG 坐标与端子坐标对齐
      layer.style.cssText =
        'position:absolute;' +
        'left:' + ((item.x || 0) + 6) + 'px;' +
        'top:'  + ((item.y || 0) + 4) + 'px;' +
        'width:' + (def.size ? def.size.width : 0) + 'px;' +
        'height:' + (def.size ? def.size.height : 0) + 'px;';
      layer.innerHTML = item.string;
      // 初始显隐：default 恒显；无 bind 的图层也恒显（如调压阀指针动画图层——
      // refreshDisplay 在无 bind 键时提前返回，不会补设这些图层的 display）；
      // 有 bind 的图层初始隐藏，由 refreshDisplay 按 params 显隐
      layer.style.display = (item.id === 'default' || !def.layerBind(item)) ? '' : 'none';
      this._imageLayers.push({ id: item.id, el: layer });
      card.appendChild(layer);

      // 元素动画绑定缓存（anims 字段）：按 data-bind='标记名' 在本图层内找元素，记录"元素 + 移动规则"，
      // 每 tick 由 _updateAnims 直接写属性（不再 querySelector；同名元素全部绑同一映射）
      if (item.anims) {
        this._animBinds = this._animBinds || [];
        for (const [mark, spec] of Object.entries(item.anims)) {
          const els = [...layer.querySelectorAll(`[data-bind='${mark}']`)];
          if (!els.length) continue;
          this._animBinds.push({
            els,
            source: spec.source,
            map: spec.map || { min: 0, max: 100 },
            move: spec.move || null,            // {from:[x0,y0], to:[x1,y1]} 直线两点式
            rotate: spec.rotate || null,        // {center:[cx,cy], from:a0, to:a1} 旋转扫角
            attrs: spec.attr || null,           // 纯数值属性插值 {属性名: [from,to]}
            terminal: spec.terminal || null,    // {id, move|rotate} 端子坐标同步
          });
          if (spec.smooth) for (const el of els) el.style.transition = 'all 0.15s linear';
        }
      }

      // 元素 class 绑定缓存（classBind 字段）：标记名 → params 键，参数值直接作为该元素的 class 名
      // （如按钮钮帽配色：CSS 提供 .cap-red / .cap-green 等样式类）
      if (item.classBind) {
        this._classBinds = this._classBinds || [];
        for (const [mark, src] of Object.entries(item.classBind)) {
          const els = [...layer.querySelectorAll(`[data-bind='${mark}']`)];
          if (!els.length) continue;
          this._classBinds.push({ els, source: src });
        }
      }
    }
    this.refreshDisplay();   // 按当前参数初始化显隐（_last 从 undefined 起必更新一次）

    // 端子圆点（isHidden 端子不建：不可见/不可点击/不可测量）
    for (const term of this.terminals) {
      if (term.isHidden) continue;
      const dot = document.createElement('div');
      dot.className = 'term-dot';
      term.dotEl = dot;
      dot.style.cssText =
        'left:' + (term.x - hr + 6) + 'px;' +
        'top:'  + (term.y - hr + 4) + 'px;' +
        'width:'  + (hr * 2) + 'px;' +
        'height:' + (hr * 2) + 'px;';
      if (term.connectLimit === 0) dot.classList.add('probe-only');   // 只可测量端子：视觉区分
      dot.addEventListener('click', e => {
        e.stopPropagation();
        // 排故模式 → 诊断事件（任何端子都可选：选对=命中故障点，选错=记入错误记录）
        if (GS.app && GS.app.faultMgr && GS.app.faultMgr.mode) {
          document.getElementById('panelWrapper').dispatchEvent(
            new CustomEvent('fault-diagnose', { detail: { terminal: term } })
          );
          return;
        }
        // 只可测量端子（connectLimit=0）：点击无效果（不可接线、不提示，如同点击空白区域）
        if (term.connectLimit === 0) return;
        // 正常/万用表模式 → 接线
        GS.wiring.onTerminalClick(this, term.id);
      });
      dot.addEventListener('mousedown', e => e.stopPropagation());
      card.appendChild(dot);
    }

    // 参数显示标签（params 条目含 display 字段 → 图上动态文本，按参数类型自动格式化；随参数写回/导入/scan 同步）
    // 样式：x/y/transform 等布局内联；fontSize/color 可选内联（配置直写时）；复杂效果用 display.class 引用 CSS 类
    this._textLabels = [];
    for (const p of def.params) {
      if (!p.display) continue;
      const d = p.display;
      const tl = document.createElement('div');
      tl.className = 'comp-text-label' + (d.class ? ' ' + d.class : '');
      tl.style.cssText =
        'position:absolute;' +
        'left:' + (d.x + 6) + 'px;' +
        'top:'  + (d.y + 4) + 'px;' +
        'transform:translate(-50%,-50%);' +
        (d.fontSize ? 'font-size:' + d.fontSize + 'px;' : '') +
        (d.color ? 'color:' + d.color + ';' : '') +
        'pointer-events:none;white-space:nowrap;z-index:5;text-align:center;';
      tl.textContent = this._formatParamDisplay(p, this.params[p.id]);
      card.appendChild(tl);
      this._textLabels.push({ el: tl, param: p });
    }
    // ★ 初始同步（含 display.when 条件显隐）：refreshDisplay 在标签创建之前调用过，
    //   when 键为 falsy 的标签必须在此立即隐藏（如气源未通气不显示气压值）
    this._syncTextLabels();

    // 删除按钮（仅未接线时显示）
    if (!this.hasWires) {
      const del = document.createElement('button');
      del.className = 'del-btn';
      del.textContent = '×';
      del.title = '删除';
      del.addEventListener('click', e => {
        e.stopPropagation();
        // App.removeComponent—见 app.js
        if (GS.app) GS.app.removeComponent(this.instanceId, true);
      });
      card.appendChild(del);
    }

    // 手动操作热区
    if (def.zones) this._bindZones(card, def);

    // 右键：导线浮于器件上时优先触发导线设置（线标面板），否则打开器件参数面板（排故模式禁用）
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (GS.app && GS.app._isLocked()) return;
      // ★ 需求：鼠标在导线上右键，优先导线的设置参数，而非器件的设置参数
      const wid = GS.wiring && GS.wiring.checkWireHover(e.clientX, e.clientY);
      if (wid && GS.app && GS.app._openWireLabelPanel) {
        GS.app._openWireLabelPanel(GS.wiring.wires.get(wid), e.clientX, e.clientY);
        return;
      }
      if (!def.panelParams().length) return;   // 无可调也无只读显示参数 → 不弹面板
      this._openParams(e.clientX, e.clientY);
    });

    // 拖动
    this._bindDrag(card);

    this.el = card;
    return card;
  }

  /* ---- 参数面板 ---- */

  _openParams(x, y) {
    if (!this.definition.adjustableParams().length) return;
    ParamPanel.open(this, x, y);
  }

  /**
   * 刷新图像显示（params 驱动，无参）。
   * 子类在 scan()/handleZoneAction()/onShortCircuit() 里更新 this.params[k] 后调用。
   * 图层显隐：image 条目 bind 字符串（"key"=truthy 显示 / "!key"=falsy 显示；无 bind 恒显；default 恒显）。
   * 内部做 _last 快照比对：所有显隐键的真值都没变 → 不碰图层 display（动画另有 _updateAnims）。
   */
  refreshDisplay() {
    const def = this.definition;
    if (!def || !this._imageLayers) return;
    this._syncTextLabels();
    this._updateAnims();   // 面板写回/事件场景的动画即时刷新（scan 路径已无条件调用，重复调用有值比对无害）
    this._updateClasses();
    const keys = def.bindKeys();
    let changed = false;
    for (const k of keys) {
      const v = !!this.params[k];
      if (this._last[k] !== v) { this._last[k] = v; changed = true; }
    }
    if (!changed) return;
    const show = new Set();
    for (const item of def.imageItems) {
      const b = def.layerBind(item);
      if (item.id === 'default') { show.add(item.id); continue; }   // default 恒显底层
      if (!b) { show.add(item.id); continue; }                     // 无 bind → 恒显
      if (b.expr.fn(this.params)) show.add(item.id);               // bind 布尔表达式（支持逻辑运算）
    }
    for (const layer of this._imageLayers) {
      layer.el.style.display = show.has(layer.id) ? '' : 'none';
    }
  }

  /** 元素 class 绑定刷新（每 tick 由基类 scan 无条件调用；按 class 值比对，稳态零开销）：
   *  classBind 配置（image 条目）标记名 → params 键，参数值直接作为该元素的 class
   *  （如钮帽配色：CSS 定义 .cap-red/.cap-yellow/… ，参数改值即换类）。 */
  _updateClasses() {
    if (!this._classBinds || !this._classBinds.length) return;
    for (const b of this._classBinds) {
      const v = this.params[b.source];
      if (v == null) continue;
      const str = String(v);
      for (const el of b.els) if (el.getAttribute('class') !== str) el.setAttribute('class', str);
    }
  }

  /**
   * 元素动画刷新（每 tick 由基类 scan 无条件调用；内部按属性值比对，稳态零开销）。
   * 绑定规则见 createDOM 缓存：source=params 键 → map 归一化 t → 写入目标：
   *   move   {from:[x0,y0], to:[x1,y1]} → 视觉写 transform 'translate(x y)'（双轴两点式直线）；
   *   rotate {center:[cx,cy], from:a0, to:a1} → 视觉写 transform 'rotate(a cx cy)'（扫角）；
   *   attrs  纯数值属性插值 {属性名:[from,to]}，"style.xxx" 前缀写 CSS、否则 setAttribute；
   *   terminal {id, move|rotate} → 端子坐标同步（move 只写 from≠to 的轴 → 十字滑台分轴互不覆盖；
   *            rotate 用配置坐标反推半径、绝对角度）→ 同步圆点 DOM + 标记 _termMoved（触发导线重算）。
   * map.min/max：数字静态；字符串引用参数："param:key"、"−param:key"（对称量程）。
   * 源值为 null → 不触碰（保持 SVG/配置里的初始状态）。
   */
  _updateAnims() {
    if (!this._animBinds || !this._animBinds.length) return;
    const resolve = x => {
      if (typeof x === 'number') return x;
      if (typeof x === 'string') {
        const neg = x.startsWith('-');
        const key = (neg ? x.slice(1) : x);
        const v = key.startsWith('param:') ? this.params[key.slice(6)] : null;
        if (v == null) return 0;
        return neg ? -v : +v;
      }
      return 0;
    };
    const lerp = (a, b, t) => a + (b - a) * t;
    const setAttr = (el, name, str) => {
      if (name.startsWith('style.')) {
        const k = name.slice(6);
        if (el.style[k] !== str) el.style[k] = str;
      } else {
        if (el.getAttribute(name) !== str) el.setAttribute(name, str);
      }
    };
    for (const b of this._animBinds) {
      const v = this.params[b.source];
      if (v == null) continue;   // 源键未写 → 保持初始（SVG/配置写死值）
      const mn = resolve(b.map.min), mx = resolve(b.map.max);
      const span = mx - mn;
      const t = span === 0 ? 0 : Math.max(0, Math.min(1, (v - mn) / span));

      // 视觉：move / rotate / 纯数值属性
      if (b.move) {
        const str = 'translate(' + lerp(b.move.from[0], b.move.to[0], t).toFixed(2) + ' ' +
                    lerp(b.move.from[1], b.move.to[1], t).toFixed(2) + ')';
        for (const el of b.els) if (el.getAttribute('transform') !== str) el.setAttribute('transform', str);
      } else if (b.rotate) {
        const a = lerp(b.rotate.from, b.rotate.to, t);
        const cx = b.rotate.center ? b.rotate.center[0] : 0;
        const cy = b.rotate.center ? b.rotate.center[1] : 0;
        // center=[0,0]/缺省 → 单参数 rotate（绕元素自身原点，配合外层 translate 平移定位；
        //   与 smooth 的 CSS transition 兼容——SVG 专有双参 rotate(a cx cy) 在 CSS 过渡下绕心失效）；
        // 显式中心 → rotate(a cx cy)（旧用法兼容，勿与 smooth 混用）
        const str = (cx === 0 && cy === 0)
          ? 'rotate(' + a.toFixed(2) + ')'
          : 'rotate(' + a.toFixed(2) + ' ' + cx + ' ' + cy + ')';
        for (const el of b.els) if (el.getAttribute('transform') !== str) el.setAttribute('transform', str);
      }
      if (b.attrs) {
        for (const [name, spec] of Object.entries(b.attrs)) {
          if (!Array.isArray(spec)) continue;
          const str = String(lerp(spec[0], spec[1], t));
          for (const el of b.els) setAttr(el, name, str);
        }
      }

      // 端子坐标同步（move 只写 from≠to 的轴；rotate 绝对角度 + 配置坐标反推半径）
      if (b.terminal) {
        const term = this.terminals.find(x => x.id === b.terminal.id);
        if (term) {
          const T = b.terminal;
          let x = term.x, y = term.y;
          if (T.move) {
            if (T.move.from[0] !== T.move.to[0]) x = lerp(T.move.from[0], T.move.to[0], t);
            if (T.move.from[1] !== T.move.to[1]) y = lerp(T.move.from[1], T.move.to[1], t);
          } else if (T.rotate) {
            const cx = T.rotate.center[0], cy = T.rotate.center[1];
            const r = Math.hypot(term.cfgX - cx, term.cfgY - cy);
            const a = lerp(T.rotate.from, T.rotate.to, t) * Math.PI / 180;
            x = cx + r * Math.cos(a); y = cy + r * Math.sin(a);
          }
          if (term.x !== x || term.y !== y) {
            term.x = x; term.y = y;
            if (term.dotEl) {
              const hr = this.definition.termHitRadius;
              term.dotEl.style.left = (x - hr + 6) + 'px';
              term.dotEl.style.top  = (y - hr + 4) + 'px';
            }
            this._termMoved = true;   // 基类 scan 末尾据此触发导线路径重算
          }
        }
      }
    }
  }

  /**
   * 参数显示标签同步（display 字段）：按参数当前值重新格式化并更新 overlay 文本。
   * 调用时机：refreshDisplay（面板写回/导入/状态变化）、子类 scan 更新运行时值后手动调用
   * （如电机转速——运行时值不触发状态变化，需无条件同步）。
   */
  _syncTextLabels() {
    if (!this._textLabels) return;
    for (const tl of this._textLabels) {
      const d = tl.param.display || {};
      // display.when：布尔表达式（与触点 when 同一解析器，支持 && || ! 括号；单键兼容），
      // 指定键 truthy 时才显示（如气源"开关通气才显示气压值"）；未配恒显示
      if (!d._whenExpr && d.when) d._whenExpr = compileExpr(d.when);   // 首次编译缓存（与实例无关，definition 共享安全）
      const show = !d.when || d._whenExpr.fn(this.params);
      const disp = show ? '' : 'none';
      if (tl.el.style.display !== disp) tl.el.style.display = disp;   // 值不变不写（稳态零 DOM 写）
      if (!show) continue;
      const t = this._formatParamDisplay(tl.param, this.params[tl.param.id]);
      if (tl.el.textContent !== t) tl.el.textContent = t;
    }
  }

  /**
   * 参数显示标签格式化（display 字段）：按参数类型生成显示文本。
   *   number → prefix + toFixed(decimals) + suffix（如 "1450 rpm"）
   *   select → 匹配 options 的 label（缺省原值）
   *   bool   → trueText/falseText（缺省 "开"/"关"）
   *   其他/text → 原样字符串
   * 未配置 display 的 param 不显示、不影响。
   */
  _formatParamDisplay(p, value) {
    if (value === undefined || value === null) return '';
    const d = p.display || {};
    if (p.type === 'number') {
      const n = Number(value) * (d.scale || 1);
      if (Number.isNaN(n)) return '';
      return (d.prefix || '') + n.toFixed(d.decimals ?? 0) + (d.suffix || '');
    }
    if (p.type === 'select') {
      const opt = (p.options || []).find(o => String(o.value) === String(value));
      return opt ? (opt.label !== undefined ? opt.label : opt.value) : String(value);
    }
    if (p.type === 'bool') return value ? (d.trueText || '开') : (d.falseText || '关');
    return String(value);
  }

  /** 更新接线锁定状态 */
  _updateWiredState() {
    const was = this.hasWires;
    this.hasWires = this.terminals.some(t => t.isConnected());
    if (this.hasWires !== was && this.el) {
      if (this.hasWires) this.el.classList.add('wired');
      else               this.el.classList.remove('wired');
    }
  }

  /* ---- 尺寸 ---- */
  cardW() { return this.definition.dispW() + 12; }
  cardH() { return this.definition.dispH() + 10; }

  /* ---- 交互热区（zones：多区 + 事件 + 动作） ---- */
  _bindZones(card, def) {
    for (const z of def.zones) {
      const zone = document.createElement('div');
      zone.className = 'comp-zone';   // 供 panel-dragging 状态下禁用悬停光标（body.panel-dragging .comp-zone）
      zone.style.cssText =
        'position:absolute;' +
        'left:'  + (z.x - z.r + 6) + 'px;' +
        'top:'   + (z.y - z.r + 4) + 'px;' +
        'width:'  + (z.r * 2) + 'px;' +
        'height:' + (z.r * 2) + 'px;' +
        'border-radius:50%;cursor:pointer;z-index:4;';
      zone.title = z.tips || z.action || '点击操作';
      zone.addEventListener('mousedown', e => e.stopPropagation());   // 防拖动
      if (z.event === 'press') {
        // 自复位：按下动作、松开复位（document mouseup 配对注册/移除）
        zone.addEventListener('mousedown', e => {
          e.stopPropagation();
          this.handleZoneAction(z.id, z.action, 'down');
          const onUp = () => {
            document.removeEventListener('mouseup', onUp);
            this.handleZoneAction(z.id, z.action, 'up');
          };
          document.addEventListener('mouseup', onUp);
        });
      } else {
        // click：点击一次触发动作
        zone.addEventListener('click', e => {
          e.stopPropagation();
          this.handleZoneAction(z.id, z.action, 'down');
        });
      }
      card.appendChild(zone);
    }
  }

  /**
   * 热区动作分发接口：基类通用实现 = zone.state 绑定（配置驱动，省略子类模板）——
   *   zones 条目带 `state` 字段时，点击自动读写 params[state]：
   *     toggle → 翻转；on/off → 置位（down 阶段）；press → 跟随相位（down=true/up=false）；
   *   写回后 refreshDisplay（图层显隐即时切换）。
   *   触点闭合（when 引用该键）由引擎每 tick scan 的 _evaluateContacts 求值（下一周期生效）。
   *   自定义动作（toggle01/setN/reset 等）由子类覆盖本方法自行解析；
   *   带额外逻辑的器件（如气源需同步 working 契约属性）覆盖时先调 super 或自行实现。
   */
  handleZoneAction(id, action, phase) {
    const z = this.definition.zones && this.definition.zones.find(z => z.id === id);
    if (!z || !z.state) return;   // 未配 state 的 zone 不做处理（留给子类）
    const key = z.state;
    switch (action) {
      case 'toggle': this.params[key] = !this.params[key]; break;
      case 'on':     if (phase === 'down') this.params[key] = true;  break;
      case 'off':    if (phase === 'down') this.params[key] = false; break;
      case 'press':  this.params[key] = phase === 'down';            break;
      default: return;
    }
    this.refreshDisplay();
  }

  /** 短路回调接口（子类按需重写；trip 能力契约方法） */
  onShortCircuit(active) {}

  /** 参数更新回调（ParamPanel 确定写回后调用），子类按需覆写 */
  onParamsChanged() {}

  /* ---- 拖动 ---- */
  _bindDrag(el) {
    let downX, downY, startLeft, startTop, startRow;
    let active = false, moved = false;

    el.addEventListener('mousedown', e => {
      // 已接线器件也允许拖动（拖动中 auto 导线实时重算敷设、manual 导线端点跟随）
      if (GS.app && GS.app._isLocked()) return;
      if (e.button !== 0) return;
      if (e.target.closest('.del-btn,.term-dot')) return;
      if (e.target.closest('.comp-label[contenteditable="true"]')) return;
      // ★ 导线/气管浮于器件上按下：导线功能优先（不启动拖动，双击删除/右键线标由面板处理）
      if (GS.wiring && GS.wiring.checkWireHover(e.clientX, e.clientY)) return;
      if (GS.app && GS.app._pushUndo && !GS.app._restoring) GS.app._pushUndo();   // 拖动可撤回（按下记快照，未移动 onUp 丢弃）
      e.preventDefault();
      downX = e.clientX; downY = e.clientY;
      startLeft = this.left; startTop = this.top || 0; startRow = this.rowIndex;
      active = true; moved = false;
      el.classList.add('dragging-in-row');
      if (GS.panel.useDuct) GS.panel._release(this.rowIndex, this.left, this.cardW());
      // ★ 拖动期间才注册全局监听，onUp 时移除（避免实例删除后监听器残留）
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const onMove = e => {
      if (!active) return;
      const dx = e.clientX - downX, dy = e.clientY - downY;
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3 && !moved) return;
      moved = true;
      const P = GS.panel;
      const z = P.zoom || 1;   // 缩放适配：视觉位移 → 逻辑位移
      if (!P.useDuct) {
        // 自由布局：自由移动 + 碰撞吸附
        const fs = P._freeSize(this);
        const pos = P._freeNearest(startLeft + dx / z, startTop + dy / z, fs.w, fs.h, this);   // ★ 排除自身，防止拖动态自碰撞闪烁
        if (pos) {
          this.left = pos.x; this.top = pos.y;
          el.style.left = pos.x + 'px'; el.style.top = pos.y + 'px';
          this._refreshWiresWhileDrag();   // 已接线器件：导线实时跟随
        }
        return;
      }
      const overRow = P._findRowAtY(e.clientY);
      if (overRow >= 0 && overRow !== this.rowIndex) {
        // 跨行：目标行内取"离鼠标最近"的空位（旧逻辑 _findSlot first-fit 恒落到行首最左 → 器件跳位）
        const desired = startLeft + (e.clientX - downX) / z;
        const valid = P._nearestFree(overRow, this.cardW(), desired);
        if (valid !== null) {
          const old = this.rowIndex;
          P._moveInstanceToRow(this, overRow);
          this.rowIndex = overRow; this.left = valid;
          el.style.left = this.left + 'px';
          P._recalcRow(old); P._recalcRow(this.rowIndex);
          this._refreshWiresWhileDrag();   // ★ 跨行后行高变化，导线路径需重算（否则显示串位）
          downX = e.clientX; downY = e.clientY;
          startLeft = this.left; startRow = this.rowIndex;
          return;
        }
      }
      const desired = startLeft + (e.clientX - downX) / z;
      const valid = P._nearestFree(this.rowIndex, this.cardW(), desired);
      if (valid !== null) { this.left = valid; el.style.left = valid + 'px'; this._refreshWiresWhileDrag(); }
    };

    /** 拖动中实时刷新导线：auto 线按新端子位置重算敷设路径；manual 线端点跟随（中间轨迹保持） */
    const _refreshWiresWhileDrag = () => {
      const P = GS.panel;
      if (P && P._refreshAllWirePaths) P._refreshAllWirePaths();
      for (const t of this.terminals) {
        for (const w of t.connections) {
          if (w.mode !== 'manual' || !w.path || w.path.length < 2) continue;
          w.path[0] = { ...w.t1.panelPos() };
          w.path[w.path.length - 1] = { ...w.t2.panelPos() };
        }
      }
    };

    const onUp = () => {
      if (!active) return;
      active = false;
      el.classList.remove('dragging-in-row');
      if (!moved && GS.app && GS.app._discardUndo) GS.app._discardUndo();   // 按下未拖动：丢弃快照（非真实操作）
      const P = GS.panel;
      if (!P.useDuct) {
        // 自由布局：位置已由 onMove 吸附，松手只需重算导线路径
        if (moved) P._refreshAllWirePaths();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        return;
      }
      if (moved) {
        if (!P._canPlace(this.rowIndex, this.left, this.cardW())) {
          const slot = P._findSlot(this.cardW(), 0, P.rowCount);
          if (slot) {
            if (slot.row !== this.rowIndex) {
              const old = this.rowIndex;
              P._moveInstanceToRow(this, slot.row);
              P._recalcRow(old);
            }
            this.left = slot.left; el.style.left = this.left + 'px';
          }
        }
        P._recalcRow(this.rowIndex);
        if (startRow !== this.rowIndex) P._recalcRow(startRow);
      }
      P._occupy(this.rowIndex, this.left, this.cardW());
      P._refreshAllWirePaths();   // ★ 行高定型后统一重算导线路径（内部含 _redrawWires）
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

  }
}
