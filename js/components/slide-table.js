/**
 * 虚拟接线仿真系统 — 十字工作台（slide-table.js）
 *
 * SlideTableInstance：电机驱动的 XY 十字工作台执行机构。
 * 形态 = 接线盘 200×200 锚点卡（绑定锚点/状态显示/3D 开关）+ 悬浮 3D 视窗（Three.js）。
 *
 * 运动学（与《十字滑台.html》演示一致，行程归一化 0~1，0.5 = 中点）：
 *   每轴绑定一台电机（xMotor/yMotor，bind allow:["speed"]）→ 读 getSpeed()（rpm 带符号），
 *   积分 dpos = (rpm/1000) × dt / strokeTime（1000rpm 下走完全程需 strokeTime 秒，X/Y 分轴可调）；
 *   位置钳位 [0,1]（到端顶死，继续同向驱动 = 位置保持 → 电机侧堵转判定自然成立）。
 *   方向语义固定：电机正转(rpm>0) → 位置增大（与 MotorInstance._tickStall 的固定映射一致）。
 *
 * 能力协议：
 *   relative-position —— relativePositions() 返回 [{label:'X轴'/'Y轴', posKey, position}]，
 *     供磁性传感器/行程开关（target+unit+detect）检测 4 个到位点、供电机（target+unit）堵转反馈。
 *
 * 扫描阶段：scanPneumatic（引擎"执行机构/气路"阶段，电气 scan 之后——电机转速已更新）。
 * 3D 视窗：three.global.js 惰性加载（window.THREE）；窗开才建渲染器（关窗 dispose 释放 WebGL）；
 *   卡片 zones action:"view3d" 开/关；实例销毁（删除/清盘）自动关窗（panel-manager destroy 钩子）。
 * 配置 singleton（只能放置一个）；无电气端子 → 排故/万用表/带电检测自动不参与。
 */
import { ComponentInstance } from './component-base.js';
// 全局单例别名 GS：scan(G, ctx) 的参数 G 是并查集，会遮蔽模块级 G
import { G as GS } from '../globals.js';
import { makeDraggable } from '../multimeter.js';
import { Table3DView } from '../table3d.js';

/** 双轴表（label 供绑定下拉；posKey/motorParam/strokeParam 为参数键名；color 供 HUD 区分） */
const AXES = [
  { key: 'x', label: 'X轴', posKey: 'x_pos', motorParam: 'xMotor', strokeParam: 'strokeTimeX', color: '#58a6ff' },
  { key: 'y', label: 'Y轴', posKey: 'y_pos', motorParam: 'yMotor', strokeParam: 'strokeTimeY', color: '#3fb950' },
];

export class SlideTableInstance extends ComponentInstance {
  static capabilities = ['relative-position'];

  constructor(def, rowIndex) {
    super(def, rowIndex);
    this._lastTick = null;      // 位置积分基准时刻（真实时间，防 tick 抖动）
    this._lastRpm = { x: 0, y: 0 };
    this._win = null;           // 3D 悬浮窗 DOM（null = 关）
    this._winDragDispose = null;   // 悬浮窗拖动监听 dispose（关窗时摘除，防 document 监听累积）
    this._view = null;          // Table3DView 实例（three 加载并初始化后）
    this._hudEls = null;        // {x, y} 位置文本元素
    this._threePromise = null;  // three 惰性加载 Promise（共享）
  }

  /** relative-position 能力契约：X/Y 轴单元（磁传感器/行程开关 detect、电机堵转判定用） */
  relativePositions() {
    return AXES.map(a => ({ label: a.label, posKey: a.posKey, position: this.params[a.posKey] ?? 0.5 }));
  }

  /** 读绑定电机当前转速（speed 能力契约方法；未绑定/实例失效 → 0） */
  _axisRpm(paramKey) {
    const m = GS.panel && GS.panel.instances.get(this.params[paramKey]);
    return (m && typeof m.getSpeed === 'function') ? (m.getSpeed() || 0) : 0;
  }

  /**
   * 执行机构阶段扫描（引擎气路段对全部实例调用，参数 pn 忽略——本器件无气路）：
   * 双轴独立积分 dpos = (rpm/1000)·dt/strokeTime，钳位 [0,1]；堵转时电机 speed 已被钳 0
   * → 位置保持端值，电机侧 stalled 判定持续成立（无乒乓）。每 tick 刷新显示并喂 3D 窗。
   */
  scanPneumatic() {
    const now = Date.now();
    const dt = this._lastTick != null ? (now - this._lastTick) / 1000 : 0;
    this._lastTick = now;
    const rpm = { x: 0, y: 0 };
    for (const a of AXES) {
      const v = this._axisRpm(a.motorParam);
      rpm[a.key] = v;
      const st = this.params[a.strokeParam] > 0 ? this.params[a.strokeParam] : 10;
      let pos = this.params[a.posKey] ?? 0.5;
      if (v && dt > 0) pos = Math.max(0, Math.min(1, pos + (v / 1000) * (dt / st)));
      this.params[a.posKey] = pos;
    }
    this._lastRpm = rpm;
    this.refreshDisplay();   // 位置 display / 动画（_updateAnims 值比对，稳态零开销）
    this._push3D();
  }

  /** 3D 窗数据注入（窗开才执行）：位置 + 转速 → 视图/丝杠动画 + HUD 文本 */
  _push3D() {
    if (!this._view) return;
    this._view.setState(this.params.x_pos ?? 0.5, this.params.y_pos ?? 0.5, this._lastRpm.x, this._lastRpm.y);
    const h = this._hudEls;
    if (h) {
      h.x.textContent = 'X ' + Math.round((this.params.x_pos ?? 0.5) * 100) + ' %';
      h.y.textContent = 'Y ' + Math.round((this.params.y_pos ?? 0.5) * 100) + ' %';
    }
  }

  /** zones 自定义动作：view3d 开/关 3D 悬浮窗（基类不处理无 state 的 action） */
  handleZoneAction(id, action, phase) {
    if (action === 'view3d' && phase === 'down') { this._toggle3D(); return; }
    super.handleZoneAction(id, action, phase);
  }

  /** 手动放置后自动弹出 3D 窗（App 拖放路径调用；场景恢复/撤回不弹） */
  open3D() { this._open3D(); }

  /** panel-manager 删除/清盘钩子：释放 3D 窗（WebGL 上下文/DOM/监听） */
  destroy() { this._close3D(); }

  /* ============ 3D 悬浮窗管理 ============ */

  _toggle3D() { if (this._win) this._close3D(); else this._open3D(); }

  _open3D() {
    if (this._win) return;
    const win = document.createElement('div');
    win.className = 'table3d-window';
    win.innerHTML =
      '<div class="table3d-title"><span class="table3d-name"></span>' +
      '<button class="table3d-close" title="关闭">×</button></div>' +
      '<div class="table3d-canvas-wrap"><canvas class="table3d-canvas"></canvas></div>' +
      '<div class="table3d-hud"><span class="hud-x"></span><span class="hud-y"></span>' +
      '<span class="table3d-hint">左键拖动旋转 · 滚轮缩放</span></div>';
    win.querySelector('.table3d-name').textContent = (this.displayName() || '十字工作台') + ' · 3D 视图';
    win.querySelector('.table3d-close').addEventListener('click', () => this._close3D());
    // 拖动：仅标题栏（canvas 旋转/按钮/底部 HUD 不触发窗体拖动）；保存 dispose 供关窗摘除
    this._winDragDispose = makeDraggable(win, 'button, canvas, .table3d-hud');
    // 初始定位：视口居中偏上（夹紧在视口内）；CSS 不写 transform（与 makeDraggable 的 offsetLeft 兼容）
    const w = 620, x = Math.max(8, Math.min(window.innerWidth - w - 8, Math.round((window.innerWidth - w) / 2)));
    win.style.left = x + 'px';
    win.style.top = '90px';
    document.body.appendChild(win);
    this._win = win;
    this._hudEls = {
      x: win.querySelector('.hud-x'),
      y: win.querySelector('.hud-y'),
    };
    this._hudEls.x.style.color = AXES[0].color;
    this._hudEls.y.style.color = AXES[1].color;

    // three 惰性加载（首次开窗注入 script；失败提示后关闭）
    this._loadThree()
      .then(() => {
        if (!this._win) return;   // 等待期间已被关闭
        try {
          this._view = new Table3DView(win.querySelector('.table3d-canvas'));
          this._view.resize();
          this._view.start();
          this._push3D();
        } catch (err) {
          this._close3D();
          if (GS.app) GS.app.showToast('3D 视图初始化失败：' + err.message, 'warn');
        }
      })
      .catch(() => {
        this._close3D();
        if (GS.app) GS.app.showToast('缺少 js/three.global.js（Three.js 库），无法显示 3D 视图', 'warn');
      });
  }

  _close3D() {
    if (!this._win) return;
    if (this._view) { this._view.dispose(); this._view = null; }
    if (this._winDragDispose) { this._winDragDispose(); this._winDragDispose = null; }   // 摘除拖动监听
    this._win.remove();
    this._win = null;
    this._hudEls = null;
  }

  /** three 全局惰性加载（单次 Promise 共享；window.THREE 已在则直接可用） */
  _loadThree() {
    if (window.THREE) return Promise.resolve();
    if (this._threePromise) return this._threePromise;
    this._threePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'js/three.global.js';
      s.onload = () => resolve();
      s.onerror = () => { this._threePromise = null; reject(new Error('three load failed')); };
      document.head.appendChild(s);
    });
    return this._threePromise;
  }
}
