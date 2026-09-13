/**
 * 虚拟接线仿真系统 — 全局引用注册表
 *
 * 解决模块间循环依赖：所有需要跨模块访问的对象在此集中存储。
 * App 初始化时注入，各模块按需读取。
 */

export const G = {
  panel: null,
  wiring: null,
  config: null,
  faultManager: null,
  app: null,
  solveResult: null,   // 当前 tick 的 SolveResult（solver.js 写入，器件 scan/折算读取）
};
