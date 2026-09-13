/**
 * 虚拟接线仿真系统 — 气缸（cylinder.js）
 *
 * CylinderInstance：单作用/双作用气缸，支持一模块多气缸单元（类似按钮组），
 * 全部由 def.raw.pneumatic.cylinders 数组配置驱动（不兼容旧 cylinder 单对象格式）：
 *
 *   "pneumatic": {
 *     "cylinders": [
 *       { "id": "c1",                       单元 id（仅标识，无状态键推导）
 *         "posKey": "c1_pos",               ★ 必填：该单元 position 参数键名（动画 source 引用它）
 *         "ports": [                        ★ 气口列表（1 个 = 单作用，2 个 = 双作用）
 *           { "id": "a1", "target": 1 },    该口通气 → 推杆目标位置（0 或 1）
 *           { "id": "b1", "target": 0 }
 *         ],
 *         "equalBehavior": 1,               双作用两侧等压(>0)时目标位置（0/1，省略=保持当前；与 noAirTarget 同格式）
 *         "noAirTarget": 0                  ★ 可选：全部气孔断气时的目标位置（0 或 1，缺省 null = 保持原位）。
 *                                            单作用弹簧复位缸写 0；双作用断气目标（如升降气缸抵消重力 → 断气下降 = 0）也走这里。
 *       }
 *     ]
 *   }
 *
 * 位置模型：每单元 posKey ∈ [0,1]（0=缩回 1=伸出），每 tick 按速度 1/strokeTime
 * （行程时间，右键可调 = 节流阀调节）朝"气压占优口的 target"积分；全部气孔断气 →
 * noAirTarget（配置了才走：单作用弹簧复位 = 0 / 双作用升降缸断气下降 = 0）；
 * 未配置 noAirTarget → 位置保持（断气停在原位，无弹簧/无外力回位的缸）。
 * 通气状态（p_a/p_b 等）为类内中间量，不写入 params。
 * 推杆动画 = image 条目 anims.move source: posKey。
 * scanPneumatic(pn) 由引擎气路段调用（气压网络已就绪）。
 */
import { ComponentInstance } from './component-base.js';

export class CylinderInstance extends ComponentInstance {
  static capabilities = ['relative-position'];   // 相对位置能力：供磁性传感器等绑定检测各单元位置

  constructor(def, rowIndex) {
    super(def, rowIndex);
    const list = def.raw && def.raw.pneumatic && Array.isArray(def.raw.pneumatic.cylinders)
      ? def.raw.pneumatic.cylinders : [];
    this._units = list.map(u => ({
      posKey: u.posKey,                       // 必填：position 参数键名
      label: u.label || u.posKey,             // 单元显示名（相对位置能力用；缺省 = posKey）
      ports: (Array.isArray(u.ports) ? u.ports : []).map(pd => {
        const t = this.terminals.find(x => x.id === pd.id);
        return { term: t, target: pd.target === 0 ? 0 : (pd.target || 1) };
      }).filter(x => x.term),                 // target：该口通气时的期望位置（0/1）
      equalBehavior: (u.equalBehavior === 0 || u.equalBehavior === 1) ? u.equalBehavior : null,   // 等压目标（省略=保持）
      noAirTarget: (u.noAirTarget === 0 || u.noAirTarget === 1) ? u.noAirTarget : null,   // 全部断气目标（null=保持原位）
    }));
    this._lastTick = null;   // 位置积分基准时刻（真实时间，防 tick 抖动；全单元共享）
  }

  /** 相对位置能力契约：各单元 {label, posKey, position(当前 0~1)}（磁性传感器绑定/单元下拉/到位检测用） */
  relativePositions() {
    return this._units.map(u => ({ label: u.label, posKey: u.posKey, position: this.params[u.posKey] ?? 0 }));
  }

  /** 气缸有效：至少 1 个单元且每单元至少 1 个有效气口 */
  _valid() {
    return this._units.length > 0 && this._units.every(u => u.ports.length >= 1);
  }

  /** 气路段扫描：逐单元读气压 → 目标位置 → 积分 → 只写本单元 posKey */
  scanPneumatic(pn) {
    if (!this._valid()) return;
    const now = Date.now();
    const dt = this._lastTick !== null ? (now - this._lastTick) / 1000 : 0;
    this._lastTick = now;
    const st = this.params.strokeTime;

    for (const u of this._units) {
      const p = u.ports.map(x => pn.pressureOf(x.term));
      let target = null;   // null = 保持当前（无目标）

      if (p.length === 1) {
        // 单作用：通气 → 该口 target；断气 → noAirTarget（弹簧复位缸写 0；缺省 = 停在原位）
        if (p[0] > 0) target = u.ports[0].target;
        else if (u.noAirTarget != null) target = u.noAirTarget;
      } else {
        // 双作用：气压占优口决定目标；等压(>0)按 equalBehavior（0/1，省略=保持当前）
        if (p[0] > p[1])      target = u.ports[0].target;
        else if (p[1] > p[0]) target = u.ports[1].target;
        else if (p[0] > 0)    target = u.equalBehavior;   // null → 保持
        else if (u.noAirTarget != null) target = u.noAirTarget;   // 都断气：noAirTarget（如升降缸断气下降）> 保持
      }

      if (target == null) continue;
      const pos = this.params[u.posKey];
      const dir = pos < target ? 1 : (pos > target ? -1 : 0);   // 朝目标走，到位停
      if (dir !== 0 && st > 0) {
        this.params[u.posKey] = Math.max(0, Math.min(1, pos + dir * dt / st));
      }
    }
    this.refreshDisplay();   // 位置动画无条件刷新（_updateAnims 内部值比对，稳态零开销）
  }

  /** 参数写回：行程时间变化 → 积分基准重置（避免跨设置跳变） */
  onParamsChanged() {
    this._lastTick = null;
  }
}
