/**
 * 虚拟接线仿真系统 — 配置与元器件模板
 *
 * ConfigLoader: 加载 system_config_v3.json（components 文件名列表 + scenes）
 * ComponentDefinition: 将 JSON 中一条 component 解析为"元器件类型"模板
 *
 * 重构后（蓝图 §1~§3 + state 并入 params）：
 *   terminals.electrical 内四类端子对并列：
 *     contacts  触点对（when 闭合条件 + closeDelay/openDelay 时序 + 可选 resistance + fault）
 *     loads     阻抗负载（computed 钩子计算 或 params.impedance；直流电阻 params.dcResistance），兼容灯泡/线圈
 *     permanent 恒连端子对（fault 可选，通常不配）
 *     sensors   电流测量端子对（小阻值 resistance + fault），热元件/电流表分流
 *   params 统一承载一切（铭牌定值 + 面板可调项 + 逻辑状态键 + 运行时值）：
 *     - 带 `images` 字段的 params 条目 = 显示键（等价旧 state 键），驱动图层显隐，default 为初值
 *     - zones 的 "state" 字段 / contacts 的 when / loads 条目的 state 字段 → 读写 params 同名键
 *     - adjustable:true 才进右键面板；type 字段完全移除（class 必填）
 */
import { compileExpr } from './bool-expr.js';

export class ConfigLoader {
  static async load() {
    const cfg = await ConfigLoader._loadOne('./system_config_v3.json');
    if (Array.isArray(cfg.components) && cfg.components.length && typeof cfg.components[0] === 'string') {
      cfg.components = await Promise.all(
        cfg.components.map(fn => ConfigLoader._loadOne('./components/' + fn))
      );
    }
    // 场景组合同样支持文件列表（scenes/ 文件夹，与 components 同机制）；对象数组 = 内联（兼容）
    if (Array.isArray(cfg.scenes) && cfg.scenes.length && typeof cfg.scenes[0] === 'string') {
      cfg.scenes = await Promise.all(
        cfg.scenes.map(fn => ConfigLoader._loadOne('./scenes/' + fn))
      );
    }
    return cfg;
  }

  static async _loadOne(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  }
}

/** 触点/负载/传感器条目默认故障等级（显式配置覆盖）
 *  语义：0 = 所有档位可设（默认）；1 = 中等及以上档；大值（如 10/100）= 不设故障。
 *  筛选规则（fault-manager）：选中 faultLevels 第 i 档（现 "简单"/"中等"/"困难"）→ 候选 level ≤ i。 */
const DEFAULT_FAULT_LEVEL = { contacts: 0, loads: 0, permanent: 10, sensors: 10 };
const DEFAULT_FAULT_TYPES = { contacts: ['open', 'stuck'], loads: ['open'], permanent: ['open'], sensors: ['open'] };

export class ComponentDefinition {
  constructor(raw) {
    // ---- 基本标识 ----
    this.raw          = raw;   // 原始配置全量保留（气路器件读 def.raw.pneumatic/pneumaticSource/regulator 等专属字段）
    this.id          = raw.id;
    this.name        = raw.name;
    this.description = raw.description || '';
    this.tags        = raw.tags || [];
    this.size        = raw.size || null;

    // ---- class 必填（type 已移除）；category/singleton ----
    this.className   = raw.class;
    this.categoryLabel = raw.category || '其他';   // 元件库分组标签（漏写 → '其他'）
    this.singleton   = !!raw.singleton;

    // ---- 图像 & 显隐（图层显隐 = image 条目 bind 表达式；元素动画 = image 条目 anims）----
    this.imageItems  = Array.isArray(raw.image) ? raw.image : [];
    this.thumbnail   = raw.thumbnail || null;

    // ---- 参数（统一 params：定值 + adjustable 面板项）----
    this.params = Array.isArray(raw.params) ? raw.params : [];

    // ---- 端子原始数据（运行时展开）----
    this._terminalsRaw = raw.terminals;

    // ---- 电源/输入定义（蓝图 §6 配置化）----
    // source: { type:"ac", voltage:380, phases:[{pin,angle,label}] } 或 { type:"dc", voltage:24, pins:{v+:1, v-:0} }
    this.sourceDef = raw.source || null;
    // input: { pins:["l","n"], voltage:220, tolerance:0.15 }（整流器输入判定）
    this.inputDef = raw.input || null;

    // ---- 交互热区 ----
    this.zones = raw.zones || null;

    this.termHitRadius = raw.terminalHitRadius || 12;
  }

  isSingleton() { return this.singleton; }

  /** 参数默认值对象 {id: default}（含定值条目；缺省：bool→false、其余→null） */
  defaultParams() {
    const out = {};
    for (const p of this.params) {
      out[p.id] = p.default !== undefined ? p.default : (p.type === 'bool' ? false : null);
    }
    return out;
  }

  /** 面板可调参数（adjustable:true → 面板显示且可编辑） */
  adjustableParams() { return this.params.filter(p => p.adjustable === true); }

  /** 面板可见参数（adjustable 可调 ∨ readonly 只读显示；readonly 值由器件类钩子写入 params） */
  panelParams() { return this.params.filter(p => p.adjustable === true || p.readonly === true); }

  /** 显隐键集：image 条目 bind 表达式 + 触点 when 表达式引用的全部 params 键去重集合（表达式解析器提取） */
  bindKeys() {
    const keys = new Set();
    for (const it of this.imageItems) {
      const b = this.layerBind(it);
      if (b) for (const k of b.expr.keys) keys.add(k);
    }
    // 触点 when 引用的键也是消费方（tonState/tofState 等显示键写入开关判断；pairEntries 有缓存）
    for (const e of this.pairEntries().contacts) {
      if (typeof e.when !== 'string' || !e.when) continue;
      if (!e._whenKeysExpr) e._whenKeysExpr = compileExpr(e.when);
      for (const k of e._whenKeysExpr.keys) keys.add(k);
    }
    return [...keys];
  }

  /** 图层是否显隐绑定（bind 表达式字符串）；返回 {expr: 编译结果} 或 null（无绑定/动画对象） */
  layerBind(item) {
    if (typeof item.bind !== 'string' || !item.bind) return null;
    if (!item._bindExpr) item._bindExpr = compileExpr(item.bind);   // 编译一次缓存（与实例无关，definition 共享安全）
    return { expr: item._bindExpr };
  }

  thumbString() {
    return this.thumbnail || (this.imageItems[0] && this.imageItems[0].string) || '';
  }

  dispW() { return (this.size && this.size.width) || 0; }
  dispH() { return (this.size && this.size.height) || 0; }

  /* ================================================================
     端子解析
     ================================================================ */

  /** 展平 pins 为一维端子定义数组（pins 属性含 tip/isHidden/connectLimit/allowLiveConnect/faultLevel） */
  flattenTerminals() {
    const raw = this._terminalsRaw;
    if (!raw || (!raw.electrical && !raw.pneumatic)) {
      console.warn('端子配置缺少 terminals.electrical/pneumatic：', this.id);
      return [];
    }
    const out = [];
    for (const media of ['electrical', 'pneumatic']) {
      const sec = raw[media];
      if (!sec || !sec.pins) continue;
      for (const id of Object.keys(sec.pins)) {
        const td = sec.pins[id];
        out.push({
          id, x: td.x, y: td.y,
          dir: td.dir || 'down', type: media,
          tip: td.tip || null, isHidden: !!td.isHidden,
          connectLimit: td.connectLimit !== undefined ? td.connectLimit : null,   // 允许接线数（缺省读主配置 rules.defaultConnectLimit；0=只测不接）
          allowLiveConnect: !!td.allowLiveConnect,   // 允许带电接线（默认 false；true = 带电可接，如三相电源出线端子）
          faultLevel: td.faultLevel !== undefined ? td.faultLevel : 0,   // 导线接线故障等级（默认 0）
        });
      }
    }
    return out;
  }

  /**
   * 四类端子对条目（id 级，未解析成 Terminal 引用）：
   *   { category, key, media, pairs:[{a,b,index}], when, closeDelay, openDelay,
   *     resistance, computed, fault:{level,types} }
   * 条目格式（统一对象形态）：
   *   contacts/permanent/sensors 用 "pairs"（端子对数组）；loads 用 "pins"（单个端子对）。
   * 数值阻抗来源（统一由基类 _branchZ 取值，器件级 params 优先、条目值兜底）：
   *   loads    → params.impedance（computed 条目 → _computedLoadImpedance）
   *   sensors  → params.sensorResistance 兜底条目 resistance
   *   contacts → params.contactResistance 兜底条目 resistance
   * 条目级 impedance/dcResistance 旧字段已移除（死字段，无消费方）。
   */
  pairEntries() {
    if (this._pairEntriesCache) return this._pairEntriesCache;   // definition 级缓存（与实例无关，bindKeys 每 tick 调用零成本）
    const refs = { contacts: [], loads: [], permanent: [], sensors: [] };
    const raw = this._terminalsRaw;
    if (!raw) return refs;
    for (const media of ['electrical', 'pneumatic']) {
      const sec = raw[media];
      if (!sec) continue;
      for (const cat of ['contacts', 'loads', 'permanent', 'sensors']) {
        const rawCat = sec[cat];
        if (!rawCat) continue;
        for (const key of Object.keys(rawCat)) {
          const e = rawCat[key] || {};
          const pairsRaw = Array.isArray(e.pairs) ? e.pairs : (Array.isArray(e.pins) ? [e.pins] : []);
          const fault = e.fault
            ? { level: e.fault.level !== undefined ? e.fault.level : DEFAULT_FAULT_LEVEL[cat],
                types: Array.isArray(e.fault.types) ? e.fault.types : DEFAULT_FAULT_TYPES[cat] }
            : { level: DEFAULT_FAULT_LEVEL[cat], types: DEFAULT_FAULT_TYPES[cat] };
          refs[cat].push({
            category: cat, key, media,
            pairs: pairsRaw.map((p, index) => ({ a: p && p[0], b: p && p[1], index })).filter(p => p.a && p.b),
            when: e.when !== undefined ? e.when : null,
            closeDelay: e.closeDelay || 0,          // 断开→闭合 延迟 tick（默认 0 不延时）
            openDelay: e.openDelay || 0,            // 闭合→断开 延迟 tick（默认 0 不延时）
            resistance: e.resistance !== undefined ? e.resistance : null,   // contacts/sensors 数值层电阻（器件级 params 覆盖优先，此处为兜底值）
            computed: e.computed || null,           // loads 计算来源（"motor" 等）
            fault,
            // 条目级扩展字段透传（配置驱动）：
            // state（得电状态键）/ tonState / tofState（延时显示键）/ delayForceKey（延时计时动作源的强制信号键，仅计时用不写 state）
            // （条目级 voltage/voltageType/pickup/dropout/ton/tof 旧设计残留已废弃：线圈电气属性统一走器件级
            //   params.coilVoltage/coilType/pickup/dropout/delayTime，写这些条目级字段不生效）
            state: e.state, tonState: e.tonState, tofState: e.tofState, delayForceKey: e.delayForceKey,
          });
          if (e.voltage !== undefined || e.voltageType !== undefined || e.pickup !== undefined ||
              e.dropout !== undefined || e.ton !== undefined || e.tof !== undefined) {
            console.warn('[config] ' + this.id + ' 条目 "' + key + '" 使用了已废弃的条目级线圈字段' +
              '（voltage/voltageType/pickup/dropout/ton/tof），不生效——请改用器件级 ' +
              'params.coilVoltage/coilType/pickup/dropout/delayTime');
          }
        }
      }
    }
    this._pairEntriesCache = refs;
    return refs;
  }
}
