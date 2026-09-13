/**
 * 虚拟接线仿真系统 — 能力协议（capabilities.js）
 *
 * 能力 = 类静态声明（capabilities 数组）+ 命名方法契约。
 * 本文件是契约的**唯一事实来源**：开发者新增加能力在此注册（desc/methods），
 * 器件类声明后由 ComponentFactory 实例化时自动校验，漏实现立即报错。
 * （实例级状态属性如 working 不在此校验——原型级检查不适用，语义由注册表 desc 说明。）
 */
export const CAPABILITIES = {
  power: {
    desc: '电源（求解器源注册/短路检测/带电检测；实例属性 working = 是否供电）',
    methods: ['outputTerminals', 'sourceEmf'],
  },
  speed: {
    desc: '转速源（速度继电器等绑定目标）',
    methods: ['getSpeed'],
  },
  trip: {
    desc: '短路保护器件（断路器/保险丝，短路路径上时被回调跳闸）',
    methods: ['onShortCircuit'],
  },
  'pressure-source': {
    desc: '气路压力源（气压传播/串气检测/带压接线检测；pressureValue(term, inletP) 返回 MPa，inletP 为进气分量气压可空；实例属性 working = 是否供气）',
    methods: ['outputTerminals', 'pressureValue'],
  },
  'relative-position': {
    desc: '相对位置执行器（0~1 位置键，供磁性传感器等绑定目标检测位置；relativePositions() 返回 [{label, posKey, position}]）',
    methods: ['relativePositions'],
  },
};

/**
 * 校验一个类是否完整实现其声明的全部能力契约。
 * @param {Function} Cls 器件类
 * @returns {string[]} 违规描述数组（空 = 通过）
 */
export function capabilityViolations(Cls) {
  const out = [];
  const caps = Cls.capabilities || [];
  for (const name of caps) {
    const spec = CAPABILITIES[name];
    if (!spec) { out.push(`未知能力 "${name}"（未在 CAPABILITIES 注册）`); continue; }
    for (const m of spec.methods) {
      if (typeof Cls.prototype[m] !== 'function') out.push(`能力 "${name}" 缺少方法 ${m}()`);
    }
  }
  return out;
}
