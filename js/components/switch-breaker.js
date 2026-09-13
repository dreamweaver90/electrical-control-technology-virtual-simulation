/**
 * 虚拟接线仿真系统 — 断路器（switch-breaker.js）
 *
 * BreakerInstance 断路器 —— 手动合闸 switch 状态 + 短路跳闸（trip 能力）。
 * 手动合闸/分闸不再自定义 handleZoneAction：zones 配置 `state:"switch"` 后由
 * 基类通用模板处理（点击 toggle 翻转 params.switch）；短路跳闸由引擎短路回调
 * onShortCircuit 强制断开（与手动操作互不干扰）。触点闭合由配置 when 驱动。
 */
import { ComponentInstance } from './component-base.js';

/** 断路器：手动合闸（基类 zone.state 绑定）→ switch 状态；短路时引擎回调 onShortCircuit 强制断开（trip 能力）。 */
export class BreakerInstance extends ComponentInstance {
  static capabilities = ['trip'];   // 能力协议：短路保护

  /** 短路回调（trip 能力契约）：本断路器在短路路径上 → 跳闸（断开后保持，需手动合闸恢复） */
  onShortCircuit(active) {
    if (active && this.params.switch) {
      this.params.switch = false;
      this.refreshDisplay();
    }
  }
}
