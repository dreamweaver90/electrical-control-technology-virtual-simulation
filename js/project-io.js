/**
 * 虚拟接线仿真系统 — 工程快照导入/导出（project-io.js）
 *
 * 工程快照 = 与"场景组合"同构的布局定义（layoutDef），统一由 App.applyLayout 恢复：
 *   {
 *     format: "project", version: 2,
 *     layout: "duct" | "free",                  // 导出时的布局模式（导入优先按它）
 *     components: [{ id, row, left, x, y,      // 双位置都记录：当前模式为精确值，
 *                    params, label }],           //   另一模式为估算值（fallback 自动修正）
 *     wires:      [{ from:[组件索引,端子id], to:[...], color, media, label? }]
 *   }
 * 规则：
 *   - 导线一律按 auto 恢复（丢弃 manual 轨迹，重铺后随端子位置推导，跨机器宽度差异天然兼容）；
 *   - media 字段为气路预留（当前仅 electrical）；
 *   - 快照含全量 params/label，导入时逐项恢复；
 *   - bind 参数持久化值 = "@组件数组索引"（运行期 instanceId 是会话内计数器，跨会话无意义）：
 *     导出时自动改写，导入时由 App.applyLayout 统一解析回新 instanceId（resolveParamsForImport）。
 */
import { G } from './globals.js';

const FORMAT = 'project';
const VERSION = 2;   // v2：state 并入 params（组件条目只带 params，不再有 state 字段）
const FILENAME = '电气控制虚拟仿真工程.json';

/**
 * 快照用参数对象：全量拷贝，bind 参数值由运行期 instanceId 改写为 "@组件数组索引"
 * （instanceId 是会话内自增计数器，跨会话无意义；与 wires 的 [组件索引,端子id] 引用同构）。
 * @param {ComponentInstance} inst
 * @param {Map} idx 实例 → 组件数组索引
 * @param {PanelManager} panel
 */
function paramsForExport(inst, idx, panel) {
  const params = { ...inst.params };
  for (const p of inst.definition.params) {
    if (p.type !== 'bind') continue;
    const v = params[p.id];
    if (typeof v !== 'string' || v[0] === '@') continue;   // 未绑定（null）/ 已是索引引用
    const t = panel.instances.get(v);                      // v = 绑定目标的 instanceId
    const ti = t ? idx.get(t) : undefined;
    params[p.id] = ti !== undefined ? '@' + ti : null;     // 悬空引用 → 置空
  }
  return params;
}

/**
 * 布局恢复用参数对象（工程导入/场景放置共用，App.applyLayout 调用）：
 * 解析 bind 参数持久化引用 "@组件数组索引" → placed 中新实例的 instanceId。
 *   - "@n"：n 合法（0 ≤ n < placed.length）→ placed[n].instanceId；越界 → null + warn；
 *   - 其他非空字符串（如旧快照残留的 inst_N 运行期 id）在空盘放置后必然悬空 → null + warn；
 *   - null/undefined 保持原样（未绑定）。
 * @param {object} comp   布局条目 { id, params, ... }
 * @param {number} index  组件数组索引（placed 同下标）
 * @param {Array}  placed 已放置的实例数组
 * @returns {object|null} 解析后的 params 拷贝（条目无 params 返回 null；不修改原对象）
 */
export function resolveParamsForImport(comp, index, placed) {
  if (!comp || !comp.params) return null;
  const params = { ...comp.params };
  const def = placed[index].definition;
  if (!Array.isArray(def.params)) return params;
  for (const p of def.params) {
    if (p.type !== 'bind') continue;
    const v = params[p.id];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v[0] === '@') {
      const ni = Number(v.slice(1));
      if (Number.isInteger(ni) && ni >= 0 && ni < placed.length) {
        params[p.id] = placed[ni].instanceId;
      } else {
        console.warn('布局 bind 引用越界: ' + (comp.id || '?') + '.' + p.id + ' = ' + v);
        params[p.id] = null;
      }
    } else {
      console.warn('布局 bind 引用无效（应写 "@组件索引"）: ' + (comp.id || '?') + '.' + p.id + ' = ' + v);
      params[p.id] = null;
    }
  }
  return params;
}

/**
 * 收集当前配电盘快照（布局定义对象）。
 * @returns {{format,version,layout,components,wires}|null} 空盘返回 null
 */
export function collectSnapshot() {
  const panel = G.panel, wm = G.wiring;
  if (!panel || !wm || panel.instances.size === 0) return null;

  const components = [];
  const idx = new Map();   // 实例 → 组件数组索引（导线/bind 引用）
  // ① 先建全量索引（bind 目标可能排在绑定方后面，必须两遍）
  let n = 0;
  for (const inst of panel.instances.values()) idx.set(inst, n++);
  // ② 生成组件条目
  for (const inst of panel.instances.values()) {
    const c = { id: inst.definition.id };
    // 双位置：当前模式的精确值 + 另一模式的估算值（切换布局时由 fallback 修正）
    if (panel.useDuct) {
      c.row = inst.rowIndex; c.left = inst.left;
      c.x = inst.left; c.y = 60 + inst.rowIndex * 220;             // 估算自由坐标（行高约 220）
    } else {
      c.x = inst.left; c.y = inst.top || 0;
      c.row = Math.max(0, Math.round((inst.top || 0) / 220));      // 估算行号
      c.left = inst.left;
    }
    c.params = paramsForExport(inst, idx, panel);  // 全量参数（统一容器：状态键 + 用户改过的额定值/整定值等；bind 值改写为 @组件索引）
    // 名称走 params.name（标牌参数），不再有独立 label 字段
    components.push(c);
  }

  const wires = [];
  for (const w of wm.wires.values()) {
    const item = {
      from: [idx.get(w.t1.parentInst), w.t1.id],
      to:   [idx.get(w.t2.parentInst), w.t2.id],
      color: w.color,
      media: w.media || 'electrical',
    };
    if (w.label) { item.label = w.label; if (w.labelSide && w.labelSide !== 'both') item.labelSide = w.labelSide; }   // 线标 + 显示位置（非 both 才记录）
    wires.push(item);
  }

  return {
    format: FORMAT, version: VERSION,
    layout: panel.useDuct ? 'duct' : 'free',
    components, wires,
  };
}

/** 导出当前工程为 JSON 文件下载。@returns {boolean} 空盘返回 false */
export function exportProject() {
  const snap = collectSnapshot();
  if (!snap) return false;
  const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = FILENAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/**
 * 导入工程文件（JSON 文本）→ 解析校验 → 统一布局引擎恢复。
 * @returns {boolean} 是否成功（放置失败/格式错误均弹 toast）
 */
export function importProject(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); }
  catch (e) { G.app && G.app.showToast('⚠ 文件解析失败：不是有效的 JSON', 'warn'); return false; }
  if (!data || !Array.isArray(data.components) || data.components.length === 0) {
    G.app && G.app.showToast('⚠ 文件格式不正确（缺少 components 数组）', 'warn'); return false;
  }
  if (!G.app || !G.app.applyLayout) { console.error('applyLayout 未就绪'); return false; }
  return G.app.applyLayout({
    name: '工程',
    layout: data.layout || null,
    components: data.components,
    wires: data.wires || [],
  });
}
