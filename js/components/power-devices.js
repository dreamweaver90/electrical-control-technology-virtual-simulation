/**
 * 虚拟接线仿真系统 — 电源器件（power-devices.js）
 *
 * PowerSupplyBase       电源能力基类 —— capabilities:['power']（working/outputTerminals/sourceEmf 契约）
 * AcPowerInstance       交流电源 —— 恒通电源头（source 配置定义相量）
 * RectifierInstance     整流器 —— input 配置定义输入判定（|ΔU| 范围），输出为 DC 岛源
 * TransformerInstance   变压器 —— 与整流器完全同构（input 初级严格检查 + 次级 AC 源注册）
 *
 * 蓝图 §6 配置化：EMF 不再按端子 id 硬编码，来自配置 source 字段：
 *   AC: "source": { "type":"ac", "voltage":380,
 *                   "phases":[ {"pin":"l1","angle":0}, {"pin":"l2","angle":120},
 *                              {"pin":"l3","angle":-120}, {"pin":"n","magnitude":0} ] }
 *   DC: "source": { "type":"dc", "voltage":24, "pins": { "v+": 1, "v-": 0 } }
 * 整流器输入判定： "input": { "pins":["l","n"], "voltage":220, "tolerance":0.15 }
 *
 * 功率反射（power reflection）：整流器/变压器初级可配 loads 条目 computed:"reflect"，
 *   用上一 tick 次级输出复功率折算初级等效阻抗 Z_in = |V_in|² / conj(S_out)
 *   （S = U·conj(I) 相量，自动含功率因数：感性负载 Q>0 → 初级呈感性；次级 DC → Q=0，pf=1 自然成立）。
 *   未工作/次级无解/输出≈0 → 空载阻抗（励磁电流）；幅值钳位防折算爆表。
 *   这样上一级电源的电流表/功率表就能读到整流器/变压器的真实输入电流与功率。
 *
 * 可调输入/输出电压：params.inputVoltage / params.outputVoltage（adjustable）优先，
 *   配置 input.voltage / source.voltage 兜底；sourceEmf 的显式 magnitude 视为"额定电压下的幅值"，
 *   随输出电压等比缩放。
 */
import { ComponentInstance } from './component-base.js';
// 全局单例用别名 GS：scan(G, ctx) 的参数 G 是并查集，会遮蔽模块级 G
import { G as GS } from '../globals.js';

/* ---- 复数工具（模块内；与 solver.js 同构，DC 岛 im 恒 0） ---- */
const cadd = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const cmul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cdiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};

export class PowerSupplyBase extends ComponentInstance {
  static capabilities = ['power'];   // 能力协议：子类继承该声明

  constructor(def, rowIndex) {
    super(def, rowIndex);
    this.working = false;   // 默认断电；无输入无开关的电源第一 tick 即通电
  }

  /** 输出电压（次级额定）：params.outputVoltage 可调优先，配置 source.voltage 兜底 */
  _sourceVoltage() {
    const ov = this.params && this.params.outputVoltage;
    if (ov && ov > 0) return ov;
    const sd = this.definition.sourceDef;
    return sd && sd.voltage ? sd.voltage : null;
  }

  /** 输出端子（电源源端子）= source 配置里定义了 EMF 的端子（sourceEmf≠null）。
   *  与带电检测/短路检测/求解器源注册同判据。 */
  outputTerminals() {
    return this.terminals.filter(t => this.sourceEmf(t) !== null);
  }

  /** 输出端子固有电位 EMF（相量 {re,im}），按配置 source 字段生成；非源端子返回 null。
   *  显式 magnitude 视为"额定电压下的幅值"，随 _sourceVoltage() 等比缩放（支持右键改输出电压）。 */
  sourceEmf(term) {
    const sd = this.definition.sourceDef;
    if (!sd) return null;
    if (sd.type === 'ac') {
      const line = this._sourceVoltage() || 380;
      const ph = line / Math.sqrt(3);
      const item = (sd.phases || []).find(p => p.pin === term.id);
      if (!item) return null;
      const scale = sd.voltage ? line / sd.voltage : 1;   // 可调输出电压 → 相量等比缩放
      const mag = (item.magnitude !== undefined ? item.magnitude : ph) * scale;
      const ang = ((item.angle || 0) * Math.PI) / 180;
      return { re: mag * Math.cos(ang), im: mag * Math.sin(ang) };
    }
    // dc：pins 值为电压系数（×voltage）
    const pins = sd.pins || {};
    if (!(term.id in pins)) return null;
    return { re: pins[term.id] * (this._sourceVoltage() || 1), im: 0 };
  }

  /* ---- 功率反射：loads 条目 computed:"reflect" 的折算钩子（component-base numericBranches 调用） ---- */

  /** 次级输出复功率 S = Σ V_t·conj(I_t)（源端子电位 × 源电流共轭；KCL ΣI=0 → 与电位参考无关）。
   *  任一源端子电位/电流未解出 → null（次级未求解/悬空）。 */
  _secondaryPower(solve) {
    let S = { re: 0, im: 0 };
    for (const t of this.outputTerminals()) {
      const V = solve.potential(t);
      const I = solve.sourceCurrent(this, t);
      if (!V || !I) return null;
      S = cadd(S, cmul(V, { re: I.re, im: -I.im }));
    }
    return S;
  }

  /** 折算初级等效阻抗（power reflection）：Z_in = |V_in|² / conj(S_total)。
   *  初级总复功率 = 次级负载复功率 + 励磁支路复功率（S_total = S_load + S0，有/无功都叠加），
   *  → P_in = Re(S_total) = 空载损耗 + 负载功率（未钳位时精确成立，单调递增，无"带小负载反而功率更小"断崖）；
   *  空载时 S_load=0 → Z_in 连续退化为空载阻抗 Z0。
   *  未工作（输入接错/开关断开/短路锁死）→ 极大阻抗 ≈ 开路（数值层无电流、不耗功率；
   *  但支路仍存在 → 万用表欧姆档由 zdc=dcResistance 显示固定绕组直流电阻，断电可测）。 */
  _computedLoadImpedance(key) {
    const OPEN = { re: 1e9, im: 0 };   // 等效开路（1GΩ，数值层电流≈0）
    const solve = GS.solveResult;
    if (!solve || !this.working) return OPEN;   // 未工作 → 等效开路
    const input = this.definition.inputDef;
    let vin = 0;
    if (input && input.pins && input.pins.length >= 2) {
      const a = this.terminals.find(t => t.id === input.pins[0]);
      const b = this.terminals.find(t => t.id === input.pins[1]);
      const u = solve.voltageBetween(a, b);
      if (u !== null && u > 0) vin = u;
    }
    if (vin <= 0) return OPEN;   // 初级无电压（正常不可达：input 检查已拦）→ 等效开路
    const v2 = vin * vin;
    // 励磁支路复功率（并联在初级，恒存在）：S0 = |V_in|² / conj(Z0) = P0 + jQ0
    const St = this._noLoadS(v2);
    // 次级负载复功率叠加（次级悬空无解时只计励磁 → 空载，与 _noLoadZ 连续）
    const S = this._secondaryPower(solve);
    if (S) { St.re += S.re; St.im += S.im; }
    const d = St.re * St.re + St.im * St.im;
    if (d < 1e-9) return OPEN;   // 防御（励磁 Q 恒在，理论不可达）
    // Z_in = |V_in|² / conj(S_total)：等效单阻抗吸收复功率 S_total
    let Z = { re: v2 * St.re / d, im: v2 * St.im / d };
    const min = this._minInputZ();
    const zm = Math.hypot(Z.re, Z.im);
    if (zm < min) { const k = min / zm; Z = { re: Z.re * k, im: Z.im * k }; }
    return Z;
  }

  /** 励磁支路复功率（输入电压幅值平方 v2 下）：S0 = v2 / conj(Z0) = {P0, Q0} */
  _noLoadS(v2) {
    const Z0 = this._noLoadZ();
    const d = Z0.re * Z0.re + Z0.im * Z0.im;
    return { re: v2 * Z0.re / d, im: v2 * Z0.im / d };
  }

  /** 空载等效阻抗（params.noLoadImpedance 为幅值，缺省 5000Ω；也支持 {re,im} 对象直写）。
   *  以励磁感抗为主：R₀ = cosφ₀·|Z|、X₀ = sinφ₀·|Z|，cosφ₀ = params.noLoadPowerFactor（缺省 0.1）
   *  ——空载电流 |I₀| = U/|Z₀| 约 76mA，有功空载损耗 P₀ = U²·R₀/|Z₀|² 仅 ~2.9W
   *  （真实变压器空载损耗为额定功率的 0.5%~2%；纯阻空载会虚高 ~10 倍）。 */
  _noLoadZ() {
    const v = this.params && this.params.noLoadImpedance;
    const z = (typeof v === 'number' && v > 0) ? v : 5000;
    if (typeof v === 'object' && v && typeof v.re === 'number' && v.re > 0) return v;
    const pf = this.params && this.params.noLoadPowerFactor;
    const cos = (typeof pf === 'number' && pf > 0 && pf <= 1) ? pf : 0.1;
    const sin = Math.sqrt(1 - cos * cos);
    return { re: z * cos, im: z * sin };
  }

  /** 折算阻抗幅值下限（params.minInputImpedance，缺省 20Ω，防重载折算爆表） */
  _minInputZ() {
    const v = this.params && this.params.minInputImpedance;
    return (v && v > 0) ? v : 20;
  }
}

/** 交流电源：无输入端子、无开关（恒通电源头），第一 tick 即 working。 */
export class AcPowerInstance extends PowerSupplyBase {
  scan(G, ctx) {
    super.scan(G, ctx);
    this.working = true;
  }
}

/**
 * 整流器/变压器公共实现（差异全部由配置表达：source.type 决定次级 AC/DC）：
 *   input 配置两端 |ΔU| ∈ inputVoltage×(1±tolerance) → inputOk（严格检查：不满足要求不带负载）；
 *   working = inputOk && 开关闭合 && 未短路锁死；working 时输出端子注册为源。
 * 单次求解契约：本 tick 的 scan 用上一 tick 的求解结果判定，working 下一 tick 生效。
 */
export class RectifierInstance extends PowerSupplyBase {
  constructor(def, rowIndex) {
    super(def, rowIndex);
    this.inputOk = false;
  }

  /** 输入电压额定值：params.inputVoltage 可调优先，配置 input.voltage 兜底 */
  _inputVoltage() {
    const pv = this.params && this.params.inputVoltage;
    if (pv && pv > 0) return pv;
    const inp = this.definition.inputDef;
    return (inp && inp.voltage) || 220;
  }

  /** 输入容差：配置 input.tolerance（缺省 0.15） */
  _inputTolerance() {
    const inp = this.definition.inputDef;
    return (inp && inp.tolerance !== undefined) ? inp.tolerance : 0.15;
  }

  /** 短路回调：短路中 → short_circuit 状态 + 断电锁死（熔断器语义，fuse 热区复位） */
  onShortCircuit(active) {
    this.params.short_circuit = active;
    if (active) this.working = false;
    if (active) this.params.energized = false;
    this.refreshDisplay();
  }

  scan(G, ctx) {
    super.scan(G, ctx);
    // 输入判定：读上一 tick 求解结果中 input.pins 两端电位差（未定义 → 无输出）
    const input = this.definition.inputDef;
    const solve = ctx && ctx.solve;
    let inputOk = false;
    if (input && solve && input.pins && input.pins.length >= 2) {
      const ts = input.pins.map(id => this.terminals.find(t => t.id === id));
      if (ts.every(Boolean)) {
        const u = solve.voltageBetween(ts[0], ts[1]);   // 异岛/悬空 → null
        if (u !== null) {
          const vin = this._inputVoltage(), tol = this._inputTolerance();
          inputOk = u >= vin * (1 - tol) && u <= vin * (1 + tol);
        }
      }
    }
    this.inputOk = inputOk;
    const working = inputOk && this.params.switch && !this.params.short_circuit;

    if (this.working !== working) {
      this.working = working;
      this.params.energized = working;   // 显示键契约：电源统一 energized
      this.refreshDisplay();   // 显示键变化才刷新（其余每 tick 无显示变化）
    }
  }

  /**
   * 热区动作分发（配置驱动，无 zone.id 硬编码）：
   *   reset 动作 + zones 条目 state 键 → 复位（熔断器语义：更换熔断器，如 short_circuit）；
   *   其余动作走基类通用 state 绑定（toggle/on/off/press，如 switch 开关）。
   */
  handleZoneAction(id, action, phase) {
    const z = this.definition.zones && this.definition.zones.find(z => z.id === id);
    if (z && z.state && action === 'reset' && phase === 'down') {
      this.params[z.state] = false;
      this.refreshDisplay();
      return;
    }
    super.handleZoneAction(id, action, phase);
  }
}

/**
 * 变压器：与整流器完全同构（input 初级严格检查 + working 门控 + 次级 AC 源 + 功率反射折算），
 * 零覆写——差异全部由配置表达：source.type:"ac"（次级相量）、input（初级检查）、
 * loads computed:"reflect"（初级折算支路）、params 可调输入/输出电压。
 * 输出端子与其他电源混接自动判短路：次级端子 working 时注册为源端子，
 * 与其他工作电源源端子同分量即短路（与整流器/交流电源同一套 power 语义）。
 */
export class TransformerInstance extends RectifierInstance {}
