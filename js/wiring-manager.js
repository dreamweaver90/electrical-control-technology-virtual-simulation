/**
 * 虚拟接线仿真系统 — 接线管理器
 *
 * 管理所有导线、端子选中状态机、三种接线模式、导线悬停与删除。
 */

import { Wire } from './wire.js';
import { G } from './globals.js';
import { isTerminalLive, invalidateGraphCache } from './graph.js';
import { isTerminalPressurized } from './pneumatic.js';
import { hashToNum, pointToSegment } from './utils.js';

export class WiringManager {
  constructor() {
    /** @type {Map<string, Wire>} */
    this.wires = new Map();

    /** 当前选中的端子（等待连接另一端），null 表示空闲 */
    this.selectedTerminal = null;

    /** 接线模式: "manual" | "auto" */
    this.connectMode = 'auto';

    /** 当前选中的导线颜色（默认 = 主配置 wiring.electrical.defaultColor） */
    this.currentColor = (G.config && G.config.wiring && G.config.wiring.electrical &&
      G.config.wiring.electrical.defaultColor) || '#e74c3c';

    /** 当前选中的气管颜色（气路独立选色：黑/蓝） */
    this.currentPneuColor = (G.config && G.config.wiring && G.config.wiring.pneumatic &&
      G.config.wiring.pneumatic.defaultColor) || '#2f6fd0';

    /** 临时预览路径（手动轨迹或悬链线） */
    this.tempPath = [];

    /** 当前悬停的导线 ID */
    this.hoveredWireId = null;

    // 内部状态
    this._mouseH      = null;
    this._previewMode = null;   // "catenary" | null
    this._trail       = [];     // 手动模式轨迹点
  }

  /** 切换接线模式 */
  setMode(m) { this.connectMode = m; this.cancelSelection(); }

  /** 设置导线颜色 */
  setColor(c) { this.currentColor = c; }

  /** 设置气管颜色（气路独立选色） */
  setPneuColor(c) { this.currentPneuColor = c; }

  /** 当前是否为自动有槽模式 */
  get isDuctMode() {
    return this.connectMode === 'auto' && G.panel && G.panel.useDuct;
  }

  /* ================================================================
     端子点击 — 状态机
     ================================================================ */

  /**
   * 用户点击了一个端子的处理入口。
   * 空闲 → 选中；已选中 → 校验并创建导线。
   */
  onTerminalClick(inst, termId) {
    const term = inst.terminals.find(t => t.id === termId);
    if (!term) return;

    // 只可测量端子（connectLimit=0）：禁止接线
    if (term.connectLimit === 0) {
      this.cancelSelection(); return;
    }

    // 带电/带压检测
    if (this._isLive(term)) {
      this._toast(term.type === 'pneumatic' ? '⚠ 禁止带压接线！请先关闭气源' : '⚠ 禁止带电接线！');
      this.cancelSelection(); return;
    }

    // 已有选中的端子 → 尝试连接
    if (this.selectedTerminal) {
      if (this.selectedTerminal === term) { this.cancelSelection(); return; }

      // 校验
      if (this.selectedTerminal.type !== term.type) {
        this._toast('⚠ 电路和气动端子不能混接'); this.cancelSelection(); return;
      }
      if (!this.selectedTerminal.canConnect() || !term.canConnect()) {
        this._toast('⚠ 端子已接满(最多' + term.connectLimit + '根)'); this.cancelSelection(); return;
      }
      for (const w of this.selectedTerminal.connections) {
        if (w.t1 === term || w.t2 === term) {
          this._toast('⚠ 已存在连接'); this.cancelSelection(); return;
        }
      }

      // ★ 撤回快照：创建前记（快照 = 接线前状态；校验已全部通过，失败不会留下无效快照）
      if (G.app && G.app._pushUndo && !G.app._restoring) G.app._pushUndo();

      this._createWire(this.selectedTerminal, term);
      return;
    }

    // 空闲 → 选中端子
    this.selectedTerminal = term;
    term.dotEl && term.dotEl.classList.add('selected');
    this._setStatus('已选中 ' + termId + '，请点击另一个端子');

    if (this.connectMode === 'manual') {
      // 气管恒悬链线：手动轨迹仅电路导线使用
      if (term.type === 'pneumatic') this._startCatenaryPreview(term);
      else this._startManualTrace(term);
    } else if (this.connectMode === 'auto' && (!G.panel.useDuct || term.type === 'pneumatic')) {
      // 气路无论有/无线槽都用悬链线预览
      this._startCatenaryPreview(term);
    }
  }

  /** 取消当前选中 */
  cancelSelection() {
    if (this.selectedTerminal) {
      this.selectedTerminal.dotEl && this.selectedTerminal.dotEl.classList.remove('selected');
      this.selectedTerminal = null;
    }
    this.tempPath = [];
    this._previewMode = null;
    this._stopMouseTrack();
    G.panel._redrawWires();
    this._setStatus('就绪');
  }

  /* ---- 带电/带压检测 ---- */

  /**
   * 端子是否"禁止带电/带压接线"。
   * 电路 = 与任一 working 电源源端子连通（isTerminalLive）；
   * 气路 = 与任一有压分量连通（isTerminalPressurized）。
   * 豁免 = 端子配置 allowLiveConnect:true（如三相电源出线端子/气源出气端）——带电/带压状态下仍可接线。
   */
  _isLive(term) {
    if (term.allowLiveConnect) return false;
    return term.type === 'pneumatic' ? isTerminalPressurized(term) : isTerminalLive(term);
  }

  /* ---- 创建导线 ---- */

  /**
   * 创建一根导线/气管（统一入口：手动点击、场景预接线都走这里）。
   * ① 介质 = 端子类型（electrical/pneumatic），按介质取配置（颜色/粗细）；
   * ② 路径：电路按当前模式（线槽路由/悬链线/手动轨迹）；气路无论有/无线槽恒悬链线（手动模式保持轨迹）；
   * ③ 双向绑定端子 connections（容量/重复校验在 onTerminalClick 完成）；
   * ④ 记录 widthAtDraw（窗口缩放时 manual 轨迹重映射的基准宽度）→ 重绘 + 状态提示。
   * @param {Object} [opts] {media, color}（导入场景时覆盖当前选色/介质）
   */
  _createWire(t1, t2, opts = {}) {
    const media = opts.media || t1.type;
    const wcfg  = (G.config.wiring && G.config.wiring[media]) || G.config.wiring.electrical;
    const color = opts.color || (media === 'pneumatic' ? this.currentPneuColor : this.currentColor);
    // 气管恒悬链线：不进线槽、不用手动轨迹（mode 强制 auto，路径由端子位置推导）
    const mode  = media === 'pneumatic' ? 'auto' : this.connectMode;
    const isDuct = this.isDuctMode && media !== 'pneumatic';
    const wire = new Wire(t1, t2, color, wcfg.thickness || 2, mode, media);
    wire.widthAtDraw = G.panel ? G.panel._pw : 0;   // 绘制基准宽度（窗口缩放时 manual 轨迹重映射用）

    if (isDuct) {
      wire.offset1 = t1.claimOffset();
      wire.offset2 = t2.claimOffset();
    }

    wire.path = this._computePath(t1, t2, isDuct, wire);

    // 绑定
    t1.connections.push(wire);
    t2.connections.push(wire);
    this.wires.set(wire.id, wire);
    invalidateGraphCache();   // 结构变化 → 连通图缓存失效

    // 更新端子 UI
    if (!t1.canConnect()) t1.dotEl && t1.dotEl.classList.add('full');
    if (!t2.canConnect()) t2.dotEl && t2.dotEl.classList.add('full');

    if (t1.isConnected() || t2.isConnected()) {
      t1.parentInst._updateWiredState();
      t2.parentInst._updateWiredState();
    }

    this.cancelSelection();
    G.panel._redrawWires();
    this._setStatus('已连接: ' + t1.id + ' → ' + t2.id);
    return wire;
  }

  /** 按当前模式计算路径：气管恒悬链线（不走线槽/不用手动轨迹）；电路=手动轨迹/线槽路由/悬链线 */
  _computePath(t1, t2, isDuct, wire) {
    if (wire.media === 'pneumatic') return this._catenaryPath(t1.panelPos(), t2.panelPos());
    if (this.connectMode === 'manual') {
      return (this._trail && this._trail.length > 1)
        ? this._trail
        : [t1.panelPos(), t2.panelPos()];
    }
    if (!isDuct) return this._catenaryPath(t1.panelPos(), t2.panelPos());
    return this._ductRoute(t1, t2, wire);
  }

  /* ---- 路径算法 ---- */

  _catenaryPath(p1, p2) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy), sag = dist * 0.35 * 0.7;
    return [
      { x: p1.x, y: p1.y },
      { x: p1.x + dx * 0.3, y: p1.y + sag * 0.7 },
      { x: p1.x + dx * 0.7, y: p2.y + sag * 0.7 },
      { x: p2.x, y: p2.y },
    ];
  }

  _ductRoute(t1, t2, wire) {
    const P = G.panel;
    const pW = P._pw, dW = P.ductW, dH = P.ductH;

    const e1 = t1.exitPoint(wire.offset1 || 'cw');
    const e2 = t2.exitPoint(wire.offset2 || 'cw');

    const d1 = this._targetDuct(t1, e1);
    const d2 = this._targetDuct(t2, e2);

    // 槽内分布：哈希全范围 0~1（配合 _ductInner 5%~95%，导线铺满槽内不集中）
    const r1 = hashToNum(wire.id + 'a');
    const r2 = hashToNum(wire.id + 'b');
    const in1 = this._ductInner(d1, e1, r1);
    const in2 = this._ductInner(d2, e2, r2);

    const path = [t1.panelPos(), e1, in1];

    if (d1.type === d2.type && d1.idx === d2.idx) {
      // 同一个槽 → 直连
      if (d1.type === 'h') {
        path.push(in2);
      } else {
        const my = (in1.y + in2.y) / 2;
        path.push({ x: in1.x, y: my }, { x: in2.x, y: my }, in2);
      }
    } else {
      // 不同槽 → 走竖槽
      const midX = (in1.x + in2.x) / 2;
      const useR = midX > pW / 2;
      const rand = hashToNum(wire.id + 'v');   // 全范围 0~1（竖槽内 5%~95%）
      const vOffX = useR ? (pW - dW * (0.05 + rand * 0.9)) : (dW * (0.05 + rand * 0.9));

      if (d1.type === 'h') {
        const turn = { x: vOffX, y: in1.y };
        path.push(turn, turn);
      } else {
        path.push({ x: in1.x, y: in2.y });
      }
      if (d2.type === 'h') {
        const turn = { x: vOffX, y: in2.y };
        path.push(turn, turn);
      }
    }

    path.push(in2, e2, t2.panelPos());
    return this._cleanPath(path);
  }

  _targetDuct(term, exitPt) {
    const P = G.panel;
    const ri = term.parentInst.rowIndex;
    const dir = term.dir;

    if (dir === 'up' || dir === 'down') {
      const isUp = dir === 'up';
      const idx = isUp
        ? (ri === 0 ? 0 : ri)
        : (ri === P.rowCount - 1 ? P.rowCount : ri + 1);
      const ductY = this._getHDuctY(idx);
      return {
        type: 'h', idx,
        top: ductY.top, bottom: ductY.bottom,
        centerY: ductY.center,
        boundaryY: isUp ? ductY.bottom : ductY.top,
      };
    } else {
      const isL = dir === 'left';
      const cx = isL ? P.ductW / 2 : P._pw - P.ductW / 2;
      return {
        type: 'v', idx: isL ? 0 : 1,
        centerX: cx,
        boundaryX: isL ? P.ductW : P._pw - P.ductW,
      };
    }
  }

  _getHDuctY(idx) {
    const P = G.panel;
    // 行高只增不减（minHeight 从不收缩）、且只经 _recalcRow/_build 变化 → 几何缓存安全
    // （P._ductGeom 由 panel-manager 在 _recalcRow/_build 时置 null 失效）
    if (!P._ductGeom) {
      const pr = P.panelEl.getBoundingClientRect();
      const z = P.zoom || 1;   // 缩放适配：视觉差与 scroll 都除 zoom
      const arr = [];
      for (const el of P.panelEl.querySelectorAll('.wire-duct.horizontal')) {
        const r = el.getBoundingClientRect();
        arr.push({
          top:    (r.top    - pr.top) / z + P.panelEl.scrollTop / z,
          bottom: (r.bottom - pr.top) / z + P.panelEl.scrollTop / z,
          center: ((r.top + r.bottom) / 2 - pr.top) / z + P.panelEl.scrollTop / z,
        });
      }
      P._ductGeom = arr;
    }
    return P._ductGeom[idx] || { top: 0, bottom: P.ductH, center: P.ductH / 2 };
  }

  _ductInner(duct, exitPt, ratio) {
    const dH = G.panel.ductH, dW = G.panel.ductW;
    if (duct.type === 'h') {
      return { x: exitPt.x, y: duct.top + dH * (0.05 + ratio * 0.9) };   // 5%~95% 槽内分布
    } else {
      const cx = duct.centerX || 0;
      return { x: cx, y: exitPt.y };
    }
  }

  /** 删除路径中相邻重复点 */
  _cleanPath(pts) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const last = out[out.length - 1], cur = pts[i];
      if (Math.abs(cur.x - last.x) > 0.5 || Math.abs(cur.y - last.y) > 0.5) out.push(cur);
    }
    return out;
  }

  /* ---- 手动轨迹 / 悬链线预览 ---- */

  _startManualTrace(term) {
    this._stopMouseTrack();
    this._trail = [term.panelPos()];
    const onMove = e => {
      const pr = G.panel.panelEl.getBoundingClientRect();
      const z = G.panel.zoom || 1;   // 缩放适配
      this._trail.push({
        x: (e.clientX - pr.left) / z + G.panel.panelEl.scrollLeft / z,
        y: (e.clientY - pr.top)  / z + G.panel.panelEl.scrollTop  / z,
      });
      if (this._trail.length > 300) this._trail = this._trail.filter((_, i) => i % 2 === 0);
      this.tempPath = this._trail;
      G.panel._redrawWiresSoon();   // mousemove 高频路径：rAF 合帧，每帧最多重画一次
    };
    this._mouseH = onMove;
    document.addEventListener('mousemove', onMove);
  }

  _startCatenaryPreview(term) {
    this._stopMouseTrack();
    const onMove = e => {
      const pr = G.panel.panelEl.getBoundingClientRect();
      const z = G.panel.zoom || 1;   // 缩放适配
      this._previewMode = 'catenary';
      this.tempPath = this._catenaryPath(term.panelPos(), {
        x: (e.clientX - pr.left) / z + G.panel.panelEl.scrollLeft / z,
        y: (e.clientY - pr.top)  / z + G.panel.panelEl.scrollTop  / z,
      });
      G.panel._redrawWiresSoon();   // mousemove 高频路径：rAF 合帧，每帧最多重画一次
    };
    this._mouseH = onMove;
    document.addEventListener('mousemove', onMove);
  }

  _stopMouseTrack() {
    if (this._mouseH) {
      document.removeEventListener('mousemove', this._mouseH);
      this._mouseH = null;
    }
  }

  /* ---- 导线删除 ---- */

  /** 断开导线两端（释放出线偏移、解除端子连接、刷新接线态），不删 Map 记录 */
  _detachWire(w) {
    if (w.offset1) w.t1.releaseOffset(w.offset1);
    if (w.offset2) w.t2.releaseOffset(w.offset2);

    const i1 = w.t1.connections.indexOf(w); if (i1 >= 0) w.t1.connections.splice(i1, 1);
    const i2 = w.t2.connections.indexOf(w); if (i2 >= 0) w.t2.connections.splice(i2, 1);

    w.t1.dotEl && w.t1.dotEl.classList.remove('full');
    w.t2.dotEl && w.t2.dotEl.classList.remove('full');

    w.t1.parentInst._updateWiredState();
    w.t2.parentInst._updateWiredState();
  }

  /** 清除所有导线 */
  clearAllWires() {
    for (const w of this.wires.values()) this._detachWire(w);
    this.wires.clear();
    invalidateGraphCache();   // 结构变化 → 连通图缓存失效
    this.cancelSelection();
    G.panel._redrawWires();
  }

  /** 删除单根导线 */
  removeOneWire(wireId) {
    const w = this.wires.get(wireId);
    if (!w) return;

    this._detachWire(w);

    this.wires.delete(wireId);
    invalidateGraphCache();   // 结构变化 → 连通图缓存失效
    if (this.hoveredWireId === wireId) this.hoveredWireId = null;
    G.panel._redrawWires();
  }

  /* ---- 导线悬停 ---- */

  /** 三次贝塞尔采样点（与 _dw 渲染的 bezierCurveTo 一致，悬链线 4 点路径用） */
  _bezierSample(path, t) {
    const p0 = path[0], p1 = path[1], p2 = path[2], p3 = path[3];
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
  }

  /** 检测鼠标位置是否在某导线上，返回 wireId 或 null（命中阈值按线宽自适应：粗气管更容易点中） */
  checkWireHover(clientX, clientY) {
    if (G.panel && G.panel.hideWires) return null;   // 连接线隐藏：悬停/右键/双击/排故点击全部失效（看不到线不可交互）
    const pr = G.panel.panelEl.getBoundingClientRect();
    const z = G.panel.zoom || 1;   // 缩放适配
    const px = (clientX - pr.left) / z + G.panel.panelEl.scrollLeft / z;
    const py = (clientY - pr.top)  / z + G.panel.panelEl.scrollTop  / z;
    let found = null;

    for (const w of this.wires.values()) {
      const threshold = Math.max(6, ((w.thickness || 5) / 2) + 4);
      let hit = false;
      if (w.path.length === 4) {
        // 悬链线：渲染为三次贝塞尔曲线，折线段检测会与曲线偏差（误判/漏判）
        // → 按曲线 16 段采样逐段检测（与渲染同一条曲线，误差 < 1px）
        const STEP = 16;
        let prev = this._bezierSample(w.path, 0);
        for (let i = 1; i <= STEP; i++) {
          const cur = this._bezierSample(w.path, i / STEP);
          if (pointToSegment(px, py, prev.x, prev.y, cur.x, cur.y) < threshold) { hit = true; break; }
          prev = cur;
        }
      } else {
        for (let i = 1; i < w.path.length; i++) {
          const seg = w.path;
          if (pointToSegment(px, py, seg[i - 1].x, seg[i - 1].y, seg[i].x, seg[i].y) < threshold) { hit = true; break; }
        }
      }
      if (hit) { found = w.id; break; }
    }

    if (found !== this.hoveredWireId) {
      this.hoveredWireId = found;
      G.panel._redrawWires();
    }
    return found;
  }

  /** 获取与指定导线等电位的所有导线 ID */
  _samePotential(wire) {
    if (!wire) return new Set();
    const visited  = new Set();
    const queue    = [wire.t1, wire.t2];
    const wireIds  = new Set();

    while (queue.length) {
      const t = queue.shift();
      if (visited.has(t)) continue;
      visited.add(t);
      for (const w of t.connections) {
        wireIds.add(w.id);
        if (!visited.has(w.t1)) queue.push(w.t1);
        if (!visited.has(w.t2)) queue.push(w.t2);
      }
    }
    return wireIds;
  }

  /* ---- 内部工具 ---- */
  _toast(msg) { G.app && G.app.showToast(msg, 'warn'); }
  _setStatus(msg) { G.app && G.app.setStatus(msg); }
}
