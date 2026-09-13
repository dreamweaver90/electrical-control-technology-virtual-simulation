/**
 * 虚拟接线仿真系统 — 器件类聚合入口（js/components/index.js）
 *
 * 器件类体系（js/components/ 文件夹）：
 *   capabilities.js     能力注册表（契约唯一事实来源）+ 校验器
 *   component-base.js   ComponentInstance 基类（DOM/拖动/四类端子对/when 求值器/数值支路通用实现）
 *   power-devices.js    PowerSupplyBase / AcPowerInstance / RectifierInstance
 *   coil-device.js      CoilDeviceInstance（接触器/继电器/时间继电器/热继电器）
 *   switch-breaker.js   BreakerInstance
 *   motor-device.js     MotorInstance
 *   meter-devices.js    VoltmeterInstance / AmmeterInstance
 *
 * 对外统一出口是 js/components.js（转发本文件）——graph/engine/multimeter/
 * fault-manager/wiring/solver/panel 全部继续 `import { X } from './components.js'`，零改动。
 */
export { ComponentInstance } from './component-base.js';
export { PowerSupplyBase, AcPowerInstance, RectifierInstance, TransformerInstance } from './power-devices.js';
export { CoilDeviceInstance } from './coil-device.js';
export { BreakerInstance } from './switch-breaker.js';
export { MotorInstance } from './motor-device.js';
export { IndicatorInstance } from './indicator.js';
export { VoltmeterInstance, AmmeterInstance, ElectricMeterInstance, SpeedMeterInstance } from './meter-devices.js';
export { PressureSourceInstance, PneumaticValveInstance, PressureRegulatorInstance } from './pneumatic-devices.js';
export { CylinderInstance } from './cylinder.js';
export { MagneticSensorInstance } from './magnetic-sensor.js';
export { LimitSwitchInstance } from './limit-switch.js';
export { FuseInstance } from './fuse.js';
export { SlideTableInstance } from './slide-table.js';
export { CAPABILITIES, capabilityViolations } from './capabilities.js';

import { ComponentInstance } from './component-base.js';
import { AcPowerInstance, RectifierInstance, TransformerInstance } from './power-devices.js';
import { CoilDeviceInstance } from './coil-device.js';
import { BreakerInstance } from './switch-breaker.js';
import { MotorInstance } from './motor-device.js';
import { IndicatorInstance } from './indicator.js';
import { VoltmeterInstance, AmmeterInstance, ElectricMeterInstance, SpeedMeterInstance } from './meter-devices.js';
import { PressureSourceInstance, PneumaticValveInstance, PressureRegulatorInstance } from './pneumatic-devices.js';
import { CylinderInstance } from './cylinder.js';
import { MagneticSensorInstance } from './magnetic-sensor.js';
import { LimitSwitchInstance } from './limit-switch.js';
import { FuseInstance } from './fuse.js';
import { SlideTableInstance } from './slide-table.js';
import { capabilityViolations } from './capabilities.js';

/* ================================================================
   工厂（class 字段必填；实例化时自动校验能力契约）
   ================================================================ */
const CLASS_MAP = {
  ComponentInstance,
  AcPowerInstance, RectifierInstance, TransformerInstance, CoilDeviceInstance,
  BreakerInstance, MotorInstance, IndicatorInstance,
  VoltmeterInstance, AmmeterInstance, ElectricMeterInstance, SpeedMeterInstance,
  PressureSourceInstance, PneumaticValveInstance, PressureRegulatorInstance, CylinderInstance,
  MagneticSensorInstance,
  LimitSwitchInstance,
  FuseInstance,
  SlideTableInstance,
};

export class ComponentFactory {
  static create(def, rowIndex) {
    const Cls = CLASS_MAP[def.className];
    if (!Cls) throw new Error('器件类未注册: ' + def.className + '（请加入 CLASS_MAP）');
    // 能力契约校验：声明了能力就必须实现契约方法（漏实现立即报错，错误信息指明缺什么）
    const v = capabilityViolations(Cls);
    if (v.length) {
      console.error('[能力校验失败] ' + def.id, v);
      throw new Error('能力校验失败（' + def.id + '）: ' + v.join('；'));
    }
    return new Cls(def, rowIndex);
  }
}
