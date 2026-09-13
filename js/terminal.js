/**
 * 虚拟接线仿真系统 — 端子
 *
 * 每个元器件实例持有 Terminal[] 数组。
 * 端子记录自身坐标、出线方向、已接导线列表。
 */

import { DIR, degToRad } from './utils.js';
import { G } from './globals.js';

export class Terminal {
  /**
   * @param {Object} td    端子定义（来自 ComponentDefinition.flattenTerminals()）
   * @param {ComponentInstance} parentInst  所属器件实例
   * @param {number} index  在实例 terminals 数组中的索引
   */
  constructor(td, parentInst, index) {
    this.id         = td.id;
    this.x          = td.x;            // 相对器件图片左上角的 X（运行时；动画 terminal 绑定可每 tick 覆盖）
    this.y          = td.y;            // 相对器件图片左上角的 Y（运行时）
    this.cfgX       = td.x;            // 配置基准坐标（复位/旋转半径反推用）
    this.cfgY       = td.y;
    this.dir        = td.dir;          // 出线方向: up/down/left/right
    this.type       = td.type || 'electrical';
    this.tip        = td.tip || null;   // 排故显示信息（无则用 id）
    this.isHidden   = !!td.isHidden;    // 隐藏端子（不可见/不可点/不可测，但实例化参与图构建）
    // 允许接线数：气孔强制 1 根气管（现实规律，不需要配置数量）；
    // 电路端子：0 = 只能测量不可接线；未配置 = 主配置 rules.defaultConnectLimit（缺省 2）
    this.connectLimit = td.type === 'pneumatic' ? 1
      : (td.connectLimit !== undefined && td.connectLimit !== null
        ? td.connectLimit
        : ((G.config && G.config.rules && G.config.rules.defaultConnectLimit) || 2));
    this.allowLiveConnect = !!td.allowLiveConnect; // 允许带电接线（默认 false；true = 带电状态下仍可接线，如三相电源出线端子）
    this.faultLevel = td.faultLevel !== undefined ? td.faultLevel : 0;   // 导线接线故障等级（默认 0；数值越大越严格，大值=不设故障）
    this.parentInst = parentInst;
    this.index      = index;

    /** @type {Wire[]} 已接导线列表（最多 2 根） */
    this.connections = [];

    /** 对应的 DOM 圆点元素 */
    this.dotEl = null;

    // 45° 出线偏移占用标记（仅自动有槽模式使用）
    this._offsetCW  = false;
    this._offsetCCW = false;
  }

  /** 端子热区半径（取自所属元器件定义） */
  get hitRadius() {
    return this.parentInst.definition.termHitRadius;
  }

  /** 是否还能接新导线（按允许接线数 connectLimit；0 = 只能测量不可接线） */
  canConnect() { return this.connections.length < this.connectLimit; }

  /** 是否已有导线 */
  isConnected() { return this.connections.length > 0; }

  /* ---- 45° 偏移方向管理 ---- */

  /** 获取可用偏移方向，无则返回 null */
  claimOffset() {
    if (!this._offsetCW)  { this._offsetCW  = true; return 'cw'; }
    if (!this._offsetCCW) { this._offsetCCW = true; return 'ccw'; }
    return null;
  }

  /** 释放偏移方向（导线删除时调用） */
  releaseOffset(dir) {
    if (dir === 'cw')  this._offsetCW  = false;
    if (dir === 'ccw') this._offsetCCW = false;
  }

  /* ---- 坐标计算 ---- */

  /** 端子中心在面板（Canvas）坐标系中的位置 */
  panelPos() {
    const card = this.parentInst.el;
    const imgEl = this.parentInst._holderEl;   // 占位元素 = 器件图像区域（v3 替代旧 _imgEl）
    if (!card || !imgEl) return { x: 0, y: 0 };

    const imgRect  = imgEl.getBoundingClientRect();
    if (!G.panel) return { x: 0, y: 0 };
    const panelEl  = G.panel.panelEl;
    const panelRect = panelEl.getBoundingClientRect();

    // 缩放适配：rect 差值是视觉距离、scrollLeft 是逻辑距离，都要除 zoom 还原面板逻辑坐标
    const z = G.panel.zoom || 1;
    return {
      x: (imgRect.left - panelRect.left) / z + panelEl.scrollLeft / z + this.x,
      y: (imgRect.top  - panelRect.top)  / z + panelEl.scrollTop  / z + this.y,
    };
  }

  /**
   * 45° 偏转出口点
   * 从端子中心沿 (dir ± 45°) 方向走 hitRadius 距离
   */
  exitPoint(offsetDir) {
    const p = this.panelPos();
    const baseAngle = DIR[this.dir].angle;
    const angle = baseAngle + (offsetDir === 'cw' ? 45 : -45);
    const rad = degToRad(angle);
    return {
      x: p.x + Math.cos(rad) * this.hitRadius,
      y: p.y + Math.sin(rad) * this.hitRadius,
    };
  }
}
