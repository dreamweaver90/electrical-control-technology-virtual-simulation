/**
 * 虚拟接线仿真系统 — 配电盘管理器
 */
import { G } from './globals.js';
import { ComponentFactory } from './components.js';
import { invalidateGraphCache } from './graph.js';   // 实例增删 → 连通图缓存失效

/** 颜色明暗调整（气管渐变描边用）：amt<0 变暗 / amt>0 变亮；hex 或 #hex */
export function shadeColor(hex, amt) {
  let c = String(hex || '#000000').replace('#', '');
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const n = parseInt(c, 16);
  if (Number.isNaN(n)) return '#000000';
  const f = x => Math.max(0, Math.min(255, Math.round(x + (amt > 0 ? 255 - x : x) * amt)));
  return 'rgb(' + f((n >> 16) & 255) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
}

/**
 * 线标渲染辅助（纯几何，可独立测试）：
 * 把导线实际绘制路径采样为折线点列 ——
 *   有线槽 auto 折线：直取路径点；
 *   悬链线（非有线槽且恰 4 点，绘制为三次贝塞尔）：按 t 采样 24 段；
 *   直线/手动密集轨迹：直取（手动绘制是二次贝塞尔链，点密时折线近似一致）。
 * @returns {Array<{x,y}>|null} 点数 < 2 返回 null
 */
export function sampleWirePath(w, useDuct) {
  const pts = w.path;
  const n = pts ? pts.length : 0;
  if (n < 2) return null;
  if (w.mode === 'auto' && useDuct && w.media !== 'pneumatic') return pts;   // 有线槽导线折线（气管恒悬链线）
  if (n === 2) return pts;                               // 直线
  if (n === 4) {                                         // 悬链线：三次贝塞尔采样
    const out = [], STEPS = 24;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS, mt = 1 - t;
      out.push({
        x: mt * mt * mt * pts[0].x + 3 * mt * mt * t * pts[1].x + 3 * mt * t * t * pts[2].x + t * t * t * pts[3].x,
        y: mt * mt * mt * pts[0].y + 3 * mt * mt * t * pts[1].y + 3 * mt * t * t * pts[2].y + t * t * t * pts[3].y,
      });
    }
    return out;
  }
  return pts;                                            // 手动轨迹（折线近似）
}

/**
 * 沿折线段表按弧长取点：返回 {x, y, ang}；d 超出总长钳位到末端；负值按 0。
 */
export function pointAlongSegs(segs, d) {
  if (d < 0) d = 0;
  for (const s of segs) {
    if (d <= s.len) return { x: s.x + Math.cos(s.ang) * d, y: s.y + Math.sin(s.ang) * d, ang: s.ang };
    d -= s.len;
  }
  const s = segs[segs.length - 1];
  return { x: s.x + Math.cos(s.ang) * s.len, y: s.y + Math.sin(s.ang) * s.len, ang: s.ang };
}

export class PanelManager {
  constructor(wrapperEl, config) {
    this.wrapperEl = wrapperEl;
    this.config = config;
    const dc = config.wireDuct || {};
    this.ductColor = dc.color || '#c8ccd0'; this.ductBorder = dc.borderColor || '#a0a4a8';
    this.ductW = dc.slotWidth || 90; this.ductH = dc.slotHeight || 90;
    // 有线槽行数配置（canvas.ductRows）：initial = 初始行数，max = 最大行数（缺省 3/10）
    const dr = (config.canvas && config.canvas.ductRows) || {};
    this.maxRows  = (dr.max     !== undefined) ? dr.max     : 10;
    this.initialRows = Math.min((dr.initial !== undefined) ? dr.initial : 3, this.maxRows);   // initial 不超过 max
    // 无线槽自由区配置（canvas.freeLayout）：相对倍数 + 绝对下限 + 扩充系数（缺省 2/5/800/1500/1.5）
    this.freeCfg = (config.canvas && config.canvas.freeLayout) || {};
    this.instances = new Map(); this.rowMap = new Map();
    this.rowCount = this.initialRows; this.useDuct = true; this._pw = 1200;
    this.freeSpace = []; this.wireCanvas = null; this.wireCtx = null;
    this.hideWires = false;   // 隐藏连接线开关（纯视图：只跳过绘制与悬停，连接关系不变；排故模式由 app 强制显示）
    this.panelEl = null;
    this._ductGeom = null;    // 横向线槽 Y 几何缓存（行高只增不减，_recalcRow/_build 时失效）
    this._rafPending = false; // rAF 合帧重画标记（mousemove 高频路径）
    G.panel = this;

    // ★ 滚轮缩放视角（所有模式）：以鼠标指针为缩放中心，不再滚动
    this.zoom = 1;
    // 撑滚动范围的元素（transform 缩放不影响布局尺寸，滚动范围会不足）。
    // 用 absolute：不占流（避免推挤 panelEl 造成上方空白），同时参与 wrapper 滚动范围计算
    this.sizeEl = document.createElement('div');
    this.sizeEl.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;';
    this.wrapperEl.appendChild(this.sizeEl);
    this.wrapperEl.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = this.wrapperEl.getBoundingClientRect();
      this._zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });

    // ★ 空白处拖拽平移视图（滚轮不再滚动后，有线槽也需要平移手段）
    this._panMoved = false;
    this.wrapperEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('.component-card') || e.target.closest('.term-dot')) return;
      const sx = e.clientX, sy = e.clientY;
      const sl = this.wrapperEl.scrollLeft, st = this.wrapperEl.scrollTop;
      let moved = false;
      const onMM = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        // 滚动容器单位 = 视觉像素（sizeEl 撑的滚动范围 = 逻辑尺寸 × zoom，见 _applyZoom），
        // 指针位移 dx 视觉像素 → scroll 同量平移（除以 zoom 会导致 zoom≠1 时内容跟不上指针漂移）
        this.wrapperEl.scrollLeft = sl - dx;
        this.wrapperEl.scrollTop  = st - dy;
      };
      const onMU = () => {
        document.removeEventListener('mousemove', onMM);
        document.removeEventListener('mouseup', onMU);
        if (moved) {
          this._panMoved = true;                     // 抑制平移后的 click（避免误取消选中）
          setTimeout(() => { this._panMoved = false; }, 80);
        }
      };
      document.addEventListener('mousemove', onMM);
      document.addEventListener('mouseup', onMU);
    });
  }

  /* ---- 缩放视角 ---- */

  /** 以面板内坐标 (px, py) 为中心缩放（保持指针下的内容点不动） */
  _zoomAt(px, py, factor) {
    const cfg = this.config.canvas || {};
    const min = cfg.minZoom || 0.2, max = cfg.maxZoom || 3;
    const nz = Math.min(max, Math.max(min, this.zoom * factor));
    if (nz === this.zoom) return;
    // 缩放前指针下的内容坐标
    const cx = (px + this.wrapperEl.scrollLeft) / this.zoom;
    const cy = (py + this.wrapperEl.scrollTop) / this.zoom;
    this.zoom = nz;
    this._applyZoom();
    // 缩放后让同一内容点仍位于指针下
    this.wrapperEl.scrollLeft = cx * this.zoom - px;
    this.wrapperEl.scrollTop  = cy * this.zoom - py;
    // 万用表探针在 panelEl 内（随面板缩放/滚动），无需额外处理
  }

  /** 应用缩放：panelEl transform + sizeEl 撑大滚动范围（transform 不影响布局尺寸） */
  _applyZoom() {
    this.panelEl.style.transform = 'scale(' + this.zoom + ')';
    this.panelEl.style.transformOrigin = '0 0';
    if (this.sizeEl) {
      this.sizeEl.style.width  = Math.ceil((this.panelEl.scrollWidth || 1) * this.zoom) + 'px';
      this.sizeEl.style.height = Math.ceil((this.panelEl.scrollHeight || 1) * this.zoom) + 'px';
    }
  }

  get innerW() { return this._pw - (this.useDuct ? this.ductW * 2 : 0); }
  get pad() { return this.useDuct ? 12 : 6; }

  init(rc, ud) { this.rowCount = rc; this.useDuct = ud; this._build(); }

  _build() {
    if (this.panelEl) this.panelEl.remove();
    this._ductGeom = null;   // DOM 重建 → 线槽几何缓存失效
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'panel' + (this.useDuct ? '' : ' no-duct free-layout');
    this.panelEl.id = 'panel'; this.panelEl.style.marginTop = '0';
    this.wrapperEl.appendChild(this.panelEl);

    if (this.useDuct) {
      // ===== 有线槽：行布局（现有机制不变） =====
      this._pw = Math.min(this.wrapperEl.clientWidth, this.config.canvas?.canvasWidth || 3000);
      this.panelEl.style.width = this._pw + 'px';
      const VD = this.ductW, HD = this.ductH;
      const IW = this.innerW, RP = this.pad;
      this.panelEl.appendChild(this._duct('h', this._pw, HD));
      const vs = 'position:absolute;top:' + HD + 'px;bottom:' + HD + 'px;width:' + VD + 'px;';
      this.panelEl.appendChild(this._duct('v', 0, 0, vs + 'left:0;'));
      this.panelEl.appendChild(this._duct('v', 0, 0, vs + 'right:0;'));
      const ct = document.createElement('div'); ct.className = 'panel-content';
      ct.style.margin = '0 ' + VD + 'px'; this.panelEl.appendChild(ct);
      for (let r = 0; r < this.rowCount; r++) {
        if (r > 0) ct.appendChild(this._duct('h', IW, HD));
        const row = document.createElement('div'); row.className = 'panel-row';
        row.dataset.rowIndex = r; row.style.width = IW + 'px';
        row.style.minHeight = '60px'; row.style.padding = RP + 'px';
        row.addEventListener('dragover', e => this._onRowDragOver(e, r));
        row.addEventListener('dragleave', e => this._onRowDragLeave(e, r));
        row.addEventListener('drop', e => this._onRowDrop(e, r));
        ct.appendChild(row);
      }
      this.panelEl.appendChild(this._duct('h', this._pw, HD));
      this._restore(); this._rebuildFreeSpace();
      for (let r = 0; r < this.rowCount; r++) this._recalcRow(r);
    } else {
      // ===== 无线槽：自由布局（无行，操作区 = 可见区域 × 配置倍率，不足垫最小绝对下限） =====
      const fl = this.freeCfg;
      const wS = fl.widthScale  || 2,  hS = fl.heightScale || 5;
      const mW = (fl.minWidth  !== undefined) ? fl.minWidth  : 800;
      const mH = (fl.minHeight !== undefined) ? fl.minHeight : 1500;
      this._freeW = Math.max(this.wrapperEl.clientWidth * wS, mW);
      this._freeH = Math.max(this.wrapperEl.clientHeight * hS, mH);
      this._pw = this._freeW;
      this.panelEl.style.width = this._freeW + 'px';
      this.panelEl.style.height = this._freeH + 'px';
      this.wrapperEl.scrollLeft = 0; this.wrapperEl.scrollTop = 0;   // 可见区域在操作区左上角
      // 元件库拖放：落点 = 操作区绝对坐标（防重叠找最近空位）
      this.panelEl.addEventListener('dragover', e => e.preventDefault());
      this.panelEl.addEventListener('drop', e => {
        e.preventDefault();
        const d = e.dataTransfer.getData('text/plain');
        if (!d) return;
        const rect = this.panelEl.getBoundingClientRect();
        // 缩放后 rect 是视觉尺寸 → 除 zoom 还原逻辑坐标
        this._dropCbAt(d, (e.clientX - rect.left) / this.zoom, (e.clientY - rect.top) / this.zoom);
      });
      this._restore();
    }

    this.wireCanvas = document.createElement('canvas'); this.wireCanvas.id = 'wireCanvas';
    this.panelEl.appendChild(this.wireCanvas); this.wireCtx = this.wireCanvas.getContext('2d');
    this._resizeCanvas();
    this._redrawWires();
    this._applyZoom();   // panelEl 重建后恢复缩放 transform
    // 万用表探针重挂（旧 panelEl 被 remove 后探针丢失）
    if (G.app && G.app.multimeter && G.app.multimeter._reattach) G.app.multimeter._reattach();
  }

  _duct(ori, w, h, extra) {
    const el = document.createElement('div');
    el.className = 'wire-duct ' + (ori === 'h' ? 'horizontal' : 'vertical');
    if (w) el.style.width = w + 'px'; if (h) el.style.height = h + 'px';
    el.style.background = this.ductColor; el.style.border = '1px solid ' + this.ductBorder;
    if (extra) el.style.cssText += ';' + extra; return el;
  }

  _restore() {
    for (const i of this.instances.values()) {
      if (!i.el) i.createDOM();
      i.el.style.left = i.left + 'px';
      if (this.useDuct) {
        const r = this._rowEl(i.rowIndex);
        if (r) r.appendChild(i.el);
      } else {
        i.el.style.top = (i.top || 0) + 'px';
        this.panelEl.appendChild(i.el);
      }
    }
  }
  _rowEl(i) { return this.panelEl && this.panelEl.querySelector('[data-row-index="' + i + '"]'); }
  _rows(i) { return this.rowMap.get(i) || []; }
  _findRowAtY(cy) { for (let r = 0; r < this.rowCount; r++) { const el = this._rowEl(r); if (!el) continue; const rect = el.getBoundingClientRect(); if (cy >= rect.top && cy <= rect.bottom) return r; } return -1; }
  _moveInstanceToRow(inst, toRow) { const fr = inst.rowIndex; const fl = this.rowMap.get(fr); if (fl) { const ix = fl.indexOf(inst); if (ix >= 0) fl.splice(ix, 1); } inst.rowIndex = toRow; if (!this.rowMap.has(toRow)) this.rowMap.set(toRow, []); this.rowMap.get(toRow).push(inst); const re = this._rowEl(toRow); if (re && inst.el) re.appendChild(inst.el); }

  /* ================================================================
     空闲区间表
     ================================================================ */
  _rebuildFreeSpace() { const IW = this.innerW, pad = this.pad; this.freeSpace = []; for (let r = 0; r < this.rowCount; r++) { const iv = [[pad, IW - pad]]; for (const i of this._rows(r)) this._sub(iv, i.left, i.cardW()); this.freeSpace.push(iv); } }
  _sub(iv, s, len) { const e = s + len; for (let i = iv.length - 1; i >= 0; i--) { const [a, b] = iv[i]; if (e <= a || s >= b) continue; iv.splice(i, 1); if (a < s) iv.splice(i, 0, [a, s]); if (b > e) iv.splice(i + (a < s ? 1 : 0), 0, [e, b]); } }
  _add(iv, s, len) { iv.push([s, s + len]); iv.sort((a, b) => a[0] - b[0]); const m = []; for (const [a, b] of iv) { if (!m.length) m.push([a, b]); else { const l = m[m.length - 1]; if (a <= l[1]) l[1] = Math.max(l[1], b); else m.push([a, b]); } } iv.length = 0; iv.push(...m); }
  _release(r, l, c) { if (r >= 0 && r < this.freeSpace.length) this._add(this.freeSpace[r], l, c); }
  _occupy(r, l, c) { if (r >= 0 && r < this.freeSpace.length) this._sub(this.freeSpace[r], l, c); }
  _canPlace(r, l, c) { if (r < 0 || r >= this.freeSpace.length) return false; const rt = l + c; for (const [s, e] of this.freeSpace[r]) { if (l >= s && rt <= e) return true; } return false; }
  _findSlot(c, sr, er) { for (let r = sr; r < er && r < this.rowCount; r++) for (const [s, e] of this.freeSpace[r]) if (e - s >= c) return { row: r, left: s }; return null; }
  _nearestFree(r, c, dx) { if (r < 0 || r >= this.freeSpace.length) return null; const IW = this.innerW, pad = this.pad; dx = Math.max(pad, Math.min(dx, IW - pad - c)); let b = null, bd = Infinity; for (const [s, e] of this.freeSpace[r]) { if (e - s < c) continue; const l = Math.max(s, Math.min(dx, e - c)), d = Math.abs(l - dx); if (d < bd) { bd = d; b = l; } } return b; }

  /** 单例占用检查：同 id 已放置 → toast + true */
  _singletonBlocked(def) {
    if (!def.isSingleton()) return false;
    for (const i of this.instances.values()) if (i.definition.id === def.id) { this._t('⚠ ' + def.name + ' 只能放置一个'); return true; }
    return false;
  }

  /** 行满自动加行并返回新行的 slot；超 maxRows 行 → toast + null */
  _addRowAndFind(cw) {
    if (this.rowCount >= this.maxRows) { this._t('⚠ 最大行数' + this.maxRows); return null; }
    this.rowCount++; this._syncRowInput(); this._build();
    return this._findSlot(cw, this.rowCount - 1, this.rowCount);
  }

  addInstance(def, rowIndex) {
    if (this._singletonBlocked(def)) return null;
    const cw = def.dispW() + 12;
    let s = this._findSlot(cw, rowIndex, this.rowCount);
    if (!s) s = this._addRowAndFind(cw);
    return s ? this._addToRow(def, s.row, s.left) : null;
  }

  /**
   * 有线槽：按指定行+left 精确放置（工程导入/场景用）。
   * fallback 链：行号超界自动加行 → 目标位置冲突本行向右找空位 → 后续行找 → 行满自动加行。
   * （解决"A 电脑导出、B 电脑一行更窄导致器件飞出接线盘"的问题）
   */
  addInstanceAt(def, row, left) {
    if (this._singletonBlocked(def)) return null;
    let r = Math.min(Math.max(row | 0, 0), this.maxRows - 1);
    while (r >= this.rowCount && this.rowCount < this.maxRows) { this.rowCount++; this._syncRowInput(); this._build(); }
    if (r >= this.rowCount) { this._t('⚠ 最大行数' + this.maxRows); return null; }
    const cw = def.dispW() + 12;
    // ① 精确位置可用 → 原样放置
    if (this._canPlace(r, left, cw)) return this._addToRow(def, r, left);
    // ② 冲突 → 本行向右/后续行 first-fit → ③ 行满自动加行
    let s = this._findSlot(cw, r, this.rowCount);
    if (!s) s = this._addRowAndFind(cw);
    return s ? this._addToRow(def, s.row, s.left) : null;
  }

  /** 自由布局：确保操作区能容纳 w×h（不足自动按 growFactor 向右/向下扩充并重设画布；判定余量 = 0，能放下即不扩） */
  _ensureFreeArea(w, h) {
    if (this.useDuct) return;
    const fl = this.freeCfg;
    const grow = (fl.growFactor !== undefined && fl.growFactor > 0) ? fl.growFactor : 1.5;
    let changed = false;
    while (this._freeW < w) { this._freeW = Math.ceil(this._freeW * grow); changed = true; }
    while (this._freeH < h) { this._freeH = Math.ceil(this._freeH * grow); changed = true; }
    if (changed) {
      this._pw = this._freeW;
      this.panelEl.style.width = this._freeW + 'px';
      this.panelEl.style.height = this._freeH + 'px';
      this._resizeCanvas();
    }
  }
  _addToRow(def, row, left) { const re = this._rowEl(row); if (!re) return null; const i = ComponentFactory.create(def, row); i.left = left; i.createDOM(); re.appendChild(i.el); this.instances.set(i.instanceId, i); invalidateGraphCache(); if (!this.rowMap.has(row)) this.rowMap.set(row, []); this.rowMap.get(row).push(i); this._occupy(row, left, i.cardW()); this._recalcRow(row); this._refreshAllWirePaths(); this._cb('added', i); return i; }
  removeInstance(iid) {
    const i = this.instances.get(iid); if (!i) return;
    if (typeof i.destroy === 'function') i.destroy();   // 实例销毁钩子（3D 窗/外部资源释放）
    if (i.el) i.el.remove();
    this.instances.delete(iid);
    invalidateGraphCache();   // 实例增删 → 连通图缓存失效（不变量：缓存 = 结构层完整快照）
    // 清理其他实例绑定本器件的 bind 参数（绑定目标被删除 → 置空）
    for (const other of this.instances.values()) {
      for (const p of (other.definition.params || [])) {
        if (p.type === 'bind' && other.params[p.id] === iid) other.params[p.id] = null;
      }
    }
    if (this.useDuct) {
      const rl = this.rowMap.get(i.rowIndex);
      if (rl) { const ix = rl.indexOf(i); if (ix >= 0) rl.splice(ix, 1); }
      this._release(i.rowIndex, i.left, i.cardW());
      this._recalcRow(i.rowIndex);
    }
    this._refreshAllWirePaths();
    this._cb('removed', i);
  }

  /* ================================================================
     自由布局（无线槽模式）：自由放置 + 防重叠 + 最近空位
     ================================================================ */
  /** 自由布局：元件放置尺寸（size 配置，缺省回退卡片尺寸） */
  _freeSize(inst) {
    const s = inst.definition.size;
    return s ? { w: s.width, h: s.height } : { w: inst.cardW(), h: inst.cardH() };
  }

  /** 自由布局：矩形是否与已有元件重叠。纯重叠判定（无单边 gap）：
   *  左右/上下任意方向逼近都能贴到 0 间距，行为对称。 */
  _collides(x, y, w, h, exclude) {
    for (const i of this.instances.values()) {
      if (i === exclude) continue;
      const s = this._freeSize(i);
      if (x < i.left + s.w && x + w > i.left &&
          y < i.top + s.h && y + h > i.top) return true;
    }
    return false;
  }

  /** 自由布局：目标位置不重叠则原样返回；重叠则行列扫描找最近空位（null = 无空位）。exclude 排除自身（拖动时必传） */
  _freeNearest(x, y, w, h, exclude) {
    const pad = 10, maxW = this._freeW - pad, maxH = this._freeH - pad;
    x = Math.max(pad, Math.min(x, maxW - w));
    y = Math.max(pad, Math.min(y, maxH - h));
    if (!this._collides(x, y, w, h, exclude)) return { x, y };
    const step = 20;
    let best = null, bd = Infinity;
    for (let cy = pad; cy + h <= maxH; cy += step) {
      for (let cx = pad; cx + w <= maxW; cx += step) {
        if (this._collides(cx, cy, w, h, exclude)) continue;
        const d = Math.hypot(cx - x, cy - y);
        if (d < bd) { bd = d; best = { x: cx, y: cy }; }
      }
    }
    return best;
  }

  /** 自由布局：放置元件到指定坐标（以落点为中心，防重叠找最近空位） */
  addFreeInstance(def, x, y) {
    if (this._singletonBlocked(def)) return null;   // 单例守卫（与 addInstance/addInstanceAt 一致；场景/工程导入 free 分支同样生效）
    const s = def.size || { width: def.dispW() + 12, height: def.dispH() + 10 };
    const pos = this._freeNearest(x - s.width / 2, y - s.height / 2, s.width, s.height);
    if (!pos) { this._t('⚠ 无空位放置'); return null; }
    const i = ComponentFactory.create(def, 0);
    i.left = pos.x; i.top = pos.y;
    i.createDOM();
    i.el.style.left = pos.x + 'px'; i.el.style.top = pos.y + 'px';
    this.panelEl.appendChild(i.el);
    this.instances.set(i.instanceId, i);
    invalidateGraphCache();   // 实例增删 → 连通图缓存失效
    this._refreshAllWirePaths();
    this._cb('added', i);
    return i;
  }

  _dropCbAt(d, x, y) { G.app && G.app.handleLibraryDropAt(d, x, y); }

  /** ★ 刷新所有导线路径（行高变化/器件移动/删除后调用）。
   *  按每根导线自身的创建模式（w.mode）决定，而不是全局当前敷设模式：
   *    auto 导线（含场景导线）路径始终由端子实时位置推导——有线槽 = 线槽路由、无线槽 = 悬链线，
   *    器件增删导致行高变化后自动跟随端子；manual 导线是手绘轨迹，保持不动。
   *  （修复：场景导线以 auto 创建，若当前敷设模式为"手动"，旧逻辑跳过重算 → 行高变化后导线脱离端子）
   *  onlyInst：只重算与该实例相连的导线（动画端子每 tick 移动时用——只受影响连接线，避免全盘重算+layout 抖动） */
  _refreshAllWirePaths(onlyInst) {
    const wm = G.wiring; if (!wm) return;
    for (const w of wm.wires.values()) {
      if (w.mode !== 'auto') continue;
      if (onlyInst && w.t1.parentInst !== onlyInst && w.t2.parentInst !== onlyInst) continue;
      // 气管恒悬链线（无论有/无线槽布局）；电路按布局走线槽/悬链线
      if (this.useDuct && w.media !== 'pneumatic') { w.path = wm._ductRoute(w.t1, w.t2, w); }
      else { w.path = wm._catenaryPath(w.t1.panelPos(), w.t2.panelPos()); }
    }
    this._redrawWires();
  }

  /** ★ 行高：取本行所有器件最大高度 */
  _recalcRow(ri) { const re = this._rowEl(ri); if (!re) return; this._ductGeom = null; let mh = this.useDuct ? 60 : 30; for (const i of this._rows(ri)) { const h = i.cardH() + (this.useDuct ? 20 : 10); if (h > mh) mh = h; } re.style.minHeight = mh + 'px'; }

  setRowCount(n) { n = Math.max(1, Math.min(this.maxRows, n)); let mr = -1; for (const i of this.instances.values()) { if (i.rowIndex > mr) mr = i.rowIndex; } if (n <= mr) { this._t('⚠ 第' + (mr + 1) + '行有器件，行数最少为 ' + (mr + 1)); this._syncRowInput(); return; } this.rowCount = n; this._rebuildMap(); this._build(); }
  setUseDuct(v) { if (this.instances.size > 0) { this._t('⚠ 请先清除元件再切换线槽'); return; } this.useDuct = v; this._build(); }
  _rebuildMap() { this.rowMap.clear(); for (const i of this.instances.values()) { if (!this.rowMap.has(i.rowIndex)) this.rowMap.set(i.rowIndex, []); this.rowMap.get(i.rowIndex).push(i); } }
  clearAll() { for (const i of this.instances.values()) { if (typeof i.destroy === 'function') i.destroy(); if (i.el) i.el.remove(); } this.instances.clear(); invalidateGraphCache(); this.rowMap.clear(); this._rebuildFreeSpace(); for (let r = 0; r < this.rowCount; r++) this._recalcRow(r); this._cb('cleared'); }

  /** ★ 窗口缩放：仅更新宽度布局与画布，不重建 DOM（保留选中/预览状态） */
  _resizePanel() {
    if (!this.panelEl) return;
    const w = Math.min(this.wrapperEl.clientWidth, this.config.canvas?.canvasWidth || 3000);
    if (w === this._pw) { this._redrawWires(); return; }
    this._pw = w;
    this.panelEl.style.width = w + 'px';
    const IW = this.innerW;
    const VD = this.useDuct ? this.ductW : 0;
    for (const el of this.panelEl.querySelectorAll('.wire-duct.horizontal')) {
      el.style.width = (el.parentNode === this.panelEl ? w : IW) + 'px';
    }
    const ct = this.panelEl.querySelector('.panel-content');
    if (ct) ct.style.margin = '0 ' + VD + 'px';
    for (const row of this.panelEl.querySelectorAll('.panel-row')) row.style.width = IW + 'px';
    this._resizeCanvas();
    // auto 导线重算路径（线槽/悬链线由端子实时位置推导）；manual 导线按宽度比例重映射（修复线槽宽度变化错位）
    this._refreshAllWirePaths();
    this._remapManualWires();
    this._redrawWires();
  }

  /** 手动导线窗口缩放重映射：端点重取端子实时位置，中间轨迹点 x 按新旧宽度比例缩放 */
  _remapManualWires() {
    const wm = G.wiring; if (!wm) return;
    for (const w of wm.wires.values()) {
      if (w.mode !== 'manual' || !w.widthAtDraw || w.widthAtDraw === this._pw) continue;
      if (w.path.length < 2) continue;
      const k = this._pw / w.widthAtDraw;
      const p1 = w.t1.panelPos(), p2 = w.t2.panelPos();
      w.path = w.path.map((pt, i) =>
        i === 0 ? p1 : (i === w.path.length - 1 ? p2 : { x: pt.x * k, y: pt.y }));
      w.widthAtDraw = this._pw;
    }
  }

  /* ---- 导线渲染 ---- */
  _resizeCanvas() {
    if (!this.wireCanvas || !this.panelEl) return;
    const h = Math.max(this.panelEl.scrollHeight || 400, 400);
    // 尺寸未变跳过：canvas.width/height 赋值会重置画布并清空后备存储，每帧白做一次
    // （canvas.width 赋值按整数截断，比较也取整——自由布局 _pw 可能为浮点）
    if (this.wireCanvas.width === (this._pw | 0) && this.wireCanvas.height === h) return;
    this.wireCanvas.width = this._pw;
    this.wireCanvas.height = h;
    this.wireCanvas.style.width = this._pw + 'px';
    this.wireCanvas.style.height = h + 'px';
  }

  /** rAF 合帧重画（mousemove 高频路径用：每帧最多重画一次，其余调用丢弃） */
  _redrawWiresSoon() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this._redrawWires();
    });
  }
  _redrawWires() { this._resizeCanvas(); const ctx = this.wireCtx; if (!ctx) return; ctx.clearRect(0, 0, this.wireCanvas.width, this.wireCanvas.height); if (this.hideWires) return; const wm = G.wiring; if (!wm) return; const hwid = wm.hoveredWireId; let ss = null; if (hwid) { const hw = wm.wires.get(hwid); if (hw) ss = wm._samePotential(hw); } const cfg = G.config.render || {}; for (const w of wm.wires.values()) { let a = 1; if (hwid) { if (w.id === hwid) a = 1; else if (ss && ss.has(w.id)) a = cfg.hoverOpacitySameGroup || 0.5; else a = cfg.hoverOpacityUnrelated || 0.15; } ctx.globalAlpha = a; this._dw(ctx, w); } ctx.globalAlpha = 1;
    if (wm.selectedTerminal && wm.tempPath.length >= 2) { const tp = wm.tempPath, ic = wm._previewMode === 'catenary'; const media = wm.selectedTerminal.type === 'pneumatic' ? 'pneumatic' : 'electrical'; ctx.strokeStyle = media === 'pneumatic' ? wm.currentPneuColor : wm.currentColor; ctx.lineWidth = (((G.config.wiring || {})[media] || G.config.wiring.electrical).thickness || 5); ctx.setLineDash([]); ctx.lineCap = ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(tp[0].x, tp[0].y); if (ic && tp.length >= 4) ctx.bezierCurveTo(tp[1].x, tp[1].y, tp[2].x, tp[2].y, tp[3].x, tp[3].y); else for (let i = 1; i < tp.length; i++) ctx.lineTo(tp[i].x, tp[i].y); ctx.stroke(); } }
  _dw(ctx, w) {
    if (w.path.length < 2) return;
    ctx.lineCap = ctx.lineJoin = 'round';
    if (w.media === 'pneumatic') {
      // 气管：多层描边从边缘浅色到中心深色连续过渡（丝滑圆柱渐变），无外边框颜色
      const LAYERS = 7;
      for (let i = 0; i < LAYERS; i++) {
        const t = i / (LAYERS - 1);   // 0 = 边缘（最宽/最浅）→ 1 = 中心（最窄/最深）
        ctx.strokeStyle = shadeColor(w.color, 0.62 - 0.95 * t);
        ctx.lineWidth = Math.max(1, w.thickness * (1 - 0.56 * t));
        this._strokePath(ctx, w);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = w.color;
      ctx.lineWidth = w.thickness;
      this._strokePath(ctx, w);
      ctx.stroke();
    }
    if (w.label) {
      if (w.labelSide !== 'start') this._dwLabel(ctx, w, true);    // 终点侧（end=true）
      if (w.labelSide !== 'end')   this._dwLabel(ctx, w, false);   // 起点侧（end=false）
    }
  }

  /** 只构建路径不落笔（气管多层描边复用同一路径；气管恒贝塞尔悬链线，不看线槽布局） */
  _strokePath(ctx, w) {
    ctx.beginPath();
    ctx.moveTo(w.path[0].x, w.path[0].y);
    if (w.mode === 'auto' && this.useDuct && w.media !== 'pneumatic') {
      for (let i = 1; i < w.path.length; i++) ctx.lineTo(w.path[i].x, w.path[i].y);
    } else if (w.path.length === 2) ctx.lineTo(w.path[1].x, w.path[1].y);
    else if (w.path.length === 4) ctx.bezierCurveTo(w.path[1].x, w.path[1].y, w.path[2].x, w.path[2].y, w.path[3].x, w.path[3].y);
    else { for (let i = 1; i < w.path.length - 1; i++) { const cx = (w.path[i].x + w.path[i + 1].x) / 2, cy = (w.path[i].y + w.path[i + 1].y) / 2; ctx.quadraticCurveTo(w.path[i].x, w.path[i].y, cx, cy); } ctx.lineTo(w.path[w.path.length - 1].x, w.path[w.path.length - 1].y); }
  }

  /** 线标渲染：导线两端各一个，文字**顺着导线走向**逐字符贴线绘制（随折点/悬链线弯折），不翻转（两头同向阅读）。
   *  end=true 末端（从终点向导线内部走）/ false 首端（从起点向导线内部走）。
   *  字号 = 主配置 wiring.electrical.labelFontSize（缺省 12）。 */
  _dwLabel(ctx, w, end) {
    const samp = sampleWirePath(w, this.useDuct);
    if (!samp) return;
    const wcfg = (G.config.wiring && G.config.wiring[w.media || 'electrical']) || {};
    const size = wcfg.labelFontSize || 12;
    ctx.font = size + 'px sans-serif';
    const chars = [...w.label];
    if (!chars.length) return;
    const walk = end ? [...samp].reverse() : samp;      // 该端向内走的点列
    const segs = [];
    for (let i = 0; i < walk.length - 1; i++) {
      const dx = walk[i + 1].x - walk[i].x, dy = walk[i + 1].y - walk[i].y;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;                          // 去零长段
      segs.push({ x: walk[i].x, y: walk[i].y, len, ang: Math.atan2(dy, dx) });
    }
    if (!segs.length) return;
    const total = segs.reduce((a, s) => a + s.len, 0);
    const margin = wcfg.labelGap != null ? wcfg.labelGap : 12;   // 线标距端点的起始内缩（wiring[media].labelGap，缺省 12）
    const avail = total - margin;
    if (avail <= 2) return;
    const widths = chars.map(c => ctx.measureText(c).width + 0.8);  // 字符宽 + 字间距
    let count = 0, used = 0;
    while (count < chars.length && used + widths[count] <= avail) { used += widths[count]; count++; }
    if (!count) return;                                 // 导线太短：从远端裁掉放不下的字符
    const h = size + 4;
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let d = margin;
    for (let k = 0; k < count; k++) {
      const p = pointAlongSegs(segs, d + widths[k] / 2);   // 字符中心处的角度（弯折处平滑过渡）
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.ang);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-widths[k] / 2 - 0.5, -h / 2, widths[k] + 1, h);
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(-widths[k] / 2 - 0.5, -h / 2, widths[k] + 1, h);
      ctx.fillStyle = '#000000';
      ctx.fillText(chars[k], -widths[k] / 2, 0.5);
      ctx.restore();
      d += widths[k];
    }
    ctx.restore();
  }

  _onRowDragOver(e, ri) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; const r = this._rowEl(ri); if (r) r.classList.add('drag-over'); }
  _onRowDragLeave(e, ri) { const r = this._rowEl(ri); if (r) r.classList.remove('drag-over'); }
  _onRowDrop(e, ri) { e.preventDefault(); const r = this._rowEl(ri); if (r) r.classList.remove('drag-over'); const d = e.dataTransfer.getData('text/plain'); if (d) this._dropCb(d, ri); }

  _t(m) { G.app && G.app.showToast(m, 'warn'); }
  _syncRowInput() { const el = document.getElementById('rowCount'); if (el) el.value = this.rowCount; }
  _cb(type, i) { if (!G.app) return; if (type === 'added') G.app.onInstanceAdded(i); else if (type === 'removed') G.app.onInstanceRemoved(i); else if (type === 'cleared') G.app.onAllCleared(); }
  _dropCb(d, ri) { G.app && G.app.handleLibraryDrop(d, ri); }
}
