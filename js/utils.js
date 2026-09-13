/**
 * 虚拟接线仿真系统 — 工具函数
 */
export const DIR = {
  up: { angle: -90 }, down: { angle: 90 }, left: { angle: 180 }, right: { angle: 0 },
};

export function degToRad(d) { return d * Math.PI / 180; }

/** 点到线段最短距离（导线 hit-test） */
export function pointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 字符串→[0,1)浮点数（稳定随机偏移）。
 *  FNV-1a 哈希：短字符串也充分扩散（Java 风格 h<<5-h 对短串不溢出 → 值偏 0，分布集中） */
export function hashToNum(s) {
  let h = 2166136261;                       // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);             // FNV prime（32 位溢出）
  }
  return ((h >>> 0) % 2147483647) / 2147483647;
}

/** #rrggbb → "rgba(r,g,b,a)" 字符串（主题配置注入 CSS 变量用）；非法输入返回 null */
export function hexToRgba(hex, alpha) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha !== undefined ? alpha : 1) + ')';
}
