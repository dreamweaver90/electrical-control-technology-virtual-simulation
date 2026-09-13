/**
 * 虚拟接线仿真系统 — 器件类对外统一出口（转发 js/components/index.js）。
 *
 * 器件类实现全部在 js/components/ 文件夹内（component-base / power-devices /
 * coil-device / switch-breaker / motor-device / meter-devices / index）。
 * 本文件只是转发，保证既有 `import { X } from './components.js'` 调用方零改动。
 */
export * from './components/index.js';
