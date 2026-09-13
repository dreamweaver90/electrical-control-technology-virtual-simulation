/**
 * 虚拟接线仿真系统 — 主控入口
 */
import { G } from './globals.js';
import { ConfigLoader, ComponentDefinition } from './config.js';
import { PanelManager } from './panel-manager.js';
import { WiringManager } from './wiring-manager.js';
import { SimulationEngine } from './engine.js';
import { LibraryPanel } from './library-panel.js';
import { FaultManager } from './fault-manager.js';
import { Multimeter, initMeterPanelDrag, makeDraggable } from './multimeter.js';
import { exportProject, importProject, resolveParamsForImport, collectSnapshot } from './project-io.js';
import { UndoManager, lcsAlign } from './undo.js';
import { hexToRgba } from './utils.js';

export class App {
  static instance = null;
  constructor() {
    App.instance = this; G.app = this;
    this.config = null; this.definitions = new Map();
    this.panel = null; this.library = null; this.wiring = null;
    this.engine = null; this.faultMgr = null; this.multimeter = null;
    this._wireLabelPanel = null;   // 线标配置面板（全局唯一）
    this._pickedWireId = null; this._pickedTermId = null;
    this.undoMgr = null;           // 撤回/重做栈（init 按主配置 undo.maxSteps 创建）
    this._restoring = false;       // 撤回恢复中：抑制埋点（导线创建/放置不重复记快照）
    this.scenes = [];   // 场景组合配置（system_config_v3.json 顶层 scenes）
  }

  async init() {
    try {
      this.setStatus('加载配置...'); this.config = await ConfigLoader.load(); G.config = this.config;
      this._applyTheme();   // 主题 CSS 变量：面板背景/端子悬停选中色（配置驱动，缺省 = CSS 默认）
      this.undoMgr = new UndoManager((this.config.undo || {}).maxSteps || 50);   // 撤回栈（快照式）
      this.setStatus('解析元器件...');
      for (const raw of this.config.components) { const def = new ComponentDefinition(raw); this.definitions.set(def.id, def); }
      this.panel = new PanelManager(document.getElementById('panelWrapper'), this.config);
      this.wiring = new WiringManager(); G.wiring = this.wiring;
      // 有线槽行数：初始值/上限取自配置 canvas.ductRows（同步输入框 value/max，缺省 3/10）
      const dr = (this.config.canvas && this.config.canvas.ductRows) || {};
      const rcMax  = (dr.max     !== undefined) ? dr.max     : 10;
      const rcInit = Math.min((dr.initial !== undefined) ? dr.initial : 3, rcMax);   // 初始不超过上限
      const rcInput = document.getElementById('rowCount');
      if (rcInput) { rcInput.value = rcInit; rcInput.max = rcMax; }
      this.panel.init(rcInput ? (parseInt(rcInput.value, 10) || rcInit) : rcInit, true);
      this.engine = new SimulationEngine(); this.engine.start();
      this.faultMgr = new FaultManager(); G.faultManager = this.faultMgr; this.multimeter = null;
      this._probeImages = null;
      const mc = this.config.multimeter || {};
      if (mc.redProbe) { const ri = await this._loadImage(mc.redProbe.fileName); const bi = await this._loadImage(mc.blackProbe.fileName);
        const scaleR = mc.redProbe.height / ri.naturalHeight, scaleB = mc.blackProbe.height / bi.naturalHeight;
        this._probeImages = { red:ri, redH:mc.redProbe.height, redW:Math.round(ri.naturalWidth*scaleR), redTipX:mc.redProbe.tipX||0, redTipY:mc.redProbe.tipY||0, black:bi, blackH:mc.blackProbe.height, blackW:Math.round(bi.naturalWidth*scaleB), blackTipX:mc.blackProbe.tipX||0, blackTipY:mc.blackProbe.tipY||0 }; }
      initMeterPanelDrag();
      makeDraggable(document.getElementById('faultPanel'), 'button');   // 排故面板可拖动（按钮除外）
      this.library = new LibraryPanel(document.getElementById('libraryContent'), Array.from(this.definitions.values()));
      this.library.render();
      this.scenes = Array.isArray(this.config.scenes) ? this.config.scenes : [];
      this.library.renderScenes(document.getElementById('libraryScenes'), this.scenes);
      this._bind(); this._buildColorPicker(); this.setStatus('就绪');
    } catch (e) { console.error(e); document.getElementById('panelWrapper').innerHTML = '<div style="padding:40px;color:#e74c3c;text-align:center"><p style="font-size:48px"></p><p>配置加载失败</p><p style="color:#999">'+e.message+'</p></div>'; }
  }

  /** 主题注入：把主配置里的颜色写到 CSS 变量（画布背景 / 端子悬停 / 端子选中）。
   *  只覆盖配了的键；缺失时 CSS :root 默认值兜底（=原视觉）。 */
  _applyTheme() {
    const st = document.documentElement.style;
    const set = (name, val) => { if (val) st.setProperty(name, val); };
    const cv = (this.config.canvas || {}).backgroundColor;
    const rd = this.config.render || {};
    set('--panel-bg', cv);
    if (rd.terminalHoverColor) {
      const h = rd.terminalHoverColor;
      set('--term-hover-fill', hexToRgba(h, 0.4));
      set('--term-hover-ring', hexToRgba(h, 0.4));
      set('--term-hover-probe', hexToRgba(h, 0.15));
      set('--term-hover-probed', hexToRgba(h, 0.45));
    }
    if (rd.terminalSelectedColor) {
      const s = rd.terminalSelectedColor;
      set('--term-selected-fill', hexToRgba(s, 0.55));
      set('--term-selected-ring', hexToRgba(s, 0.4));
    }
  }

  _bind() {
    const pw = document.getElementById('panelWrapper');
    // 元件库悬浮面板：右上角按钮开关 + 关闭按钮 + tab 切换
    const libEl = document.getElementById('library');
    const libBtn = document.getElementById('btnLibrary');
    const setLibVisible = v => {
      libEl.style.display = v ? '' : 'none';
      libBtn.classList.toggle('active', v);
    };
    libBtn?.addEventListener('click', () => setLibVisible(libEl.style.display === 'none'));
    document.getElementById('libClose')?.addEventListener('click', () => setLibVisible(false));
    document.querySelectorAll('.lib-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const isComp = tab.dataset.tab === 'components';
        document.getElementById('libraryContent').style.display = isComp ? '' : 'none';
        document.getElementById('libraryScenes').style.display = isComp ? 'none' : '';
      });
    });
    // 行数 & 线槽开关（iOS 风格单开关）& 敷设开关 & 清除
    document.getElementById('rowCount').addEventListener('change', () => { const n = parseInt(document.getElementById('rowCount').value, 10) || this.panel.initialRows; this.panel.setRowCount(n); });
    const switchDuct = document.getElementById('switchDuct'), ductLabel = document.getElementById('ductLabel');
    switchDuct?.addEventListener('click', () => {
      if (this.panel.instances.size > 0) { this.showToast('请先清除元件再切换线槽', 'warn'); return; }
      this._prepareForCleanup();   // 排故中先退出、万用表先关闭（面板重建，测量状态失效）
      const on = !this.panel.useDuct;
      this.panel.setUseDuct(on);
      switchDuct.classList.toggle('on', on);
      ductLabel.textContent = on ? '有线槽' : '无线槽';
      this._syncRowInputVisible();
    });
    const switchMode = document.getElementById('switchMode'), modeLabel = document.getElementById('modeLabel');
    switchMode?.addEventListener('click', () => {
      const auto = this.wiring.connectMode !== 'auto';
      this.wiring.setMode(auto ? 'auto' : 'manual');
      switchMode.classList.toggle('on', auto);
      modeLabel.textContent = auto ? '自动敷设' : '手动敷设';
    });
    // 显示/隐藏连线开关（纯视图状态：只影响 canvas 绘制与悬停交互，连接关系/仿真照常；
    // 不持久化——刷新页面恢复显示；排故模式强制显示，退出后回到开关设置）
    this._hideWires = false;
    const switchWires = document.getElementById('switchWires');
    switchWires?.addEventListener('click', () => {
      this._hideWires = !this._hideWires;
      this._applyWireVisibility();
      this.setStatus(this._hideWires ? '连线已隐藏（排故模式自动恢复显示）' : '连线已显示');
    });
    // 清除/切换等破坏性操作前：主动退出排故 + 关闭万用表（避免测量/诊断状态残留）
    document.getElementById('btnClearWires').addEventListener('click', () => {
      if (this.wiring.wires.size === 0) return;
      this._prepareForCleanup();
      this._pushUndo();   // 撤回：清线前记快照
      this.wiring.clearAllWires(); this.setStatus('已清除所有连线');
    });
    document.getElementById('btnClearAll').addEventListener('click', () => {
      if (this.panel.instances.size === 0) return;
      if (!confirm('确定清除所有元件和连线？')) return;
      this._prepareForCleanup();
      this._pushUndo();   // 撤回：清空前记快照
      this.wiring.clearAllWires(); this.panel.clearAll(); this.setStatus('已清除所有元件和连线');
    });

    // 撤回/重做（快照式：接线/删线/线标/器件增删拖动/清除/导入；参数与运行状态不撤回）
    document.getElementById('btnUndo')?.addEventListener('click', () => this.undo());
    document.getElementById('btnRedo')?.addEventListener('click', () => this.redo());
    this._syncUndoUI();   // 初始禁用（栈空）
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;   // 输入框内不拦截
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
    });

    // 工程导出/导入（project-io：快照下载 / 文件上传 → 统一布局引擎）
    const fileInput = document.getElementById('fileImport');
    document.getElementById('btnExport')?.addEventListener('click', () => {
      if (!exportProject()) this.showToast('配电盘为空，无可导出工程', 'warn');
      else this.setStatus('已导出工程文件');
    });
    document.getElementById('btnImport')?.addEventListener('click', () => fileInput && fileInput.click());
    fileInput?.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';   // 清空以允许重复选择同一文件
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => importProject(String(reader.result));
      reader.readAsText(f, 'utf-8');
    });

    // ESC & 空白取消（自由布局平移后的 click 忽略）
    pw.addEventListener('click', e => {
      if (G.panel && G.panel._panMoved) return;
      if (e.target.closest('.component-card')) return;
      if (e.target === pw || e.target.closest('.panel, .panel-row')) this.wiring.cancelSelection();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.wiring.cancelSelection(); });

    // 导线悬停 & 双击删除（万用表/排故模式禁止）
    pw.addEventListener('mousemove', e => {
      if (document.body.classList.contains('panel-dragging')) {   // 拖动悬浮面板（万用表/排故）：禁用导线悬停光标
        if (this._wireHoverCard) { this._wireHoverCard.style.cursor = ''; this._wireHoverCard = null; }
        pw.style.cursor = '';
        return;
      }
      const r = this.wiring.checkWireHover(e.clientX, e.clientY);
      pw.style.cursor = r ? 'pointer' : '';
      // ★ 导线/气管浮于器件上：抑制器件的拖动手光标（内联覆盖 .wired 的 grab），未命中恢复
      const card = e.target.closest('.component-card');
      if (this._wireHoverCard && this._wireHoverCard !== card) { this._wireHoverCard.style.cursor = ''; this._wireHoverCard = null; }
      if (card && r && card.classList.contains('wired')) { card.style.cursor = 'pointer'; this._wireHoverCard = card; }
    });
    pw.addEventListener('mouseleave', () => {
      pw.style.cursor = '';
      if (this._wireHoverCard) { this._wireHoverCard.style.cursor = ''; this._wireHoverCard = null; }
    });
    pw.addEventListener('dblclick', e => {
      if (this._isLocked()) return;
      // ① 导线/气管上双击 → 优先删除导线（浮于器件上也删线）
      const wid = this.wiring.checkWireHover(e.clientX, e.clientY);
      if (wid) {
        const w = this.wiring.wires.get(wid);
        this._pushUndo();
        this.wiring.removeOneWire(wid);
        this.setStatus(w && w.media === 'pneumatic' ? '已删除气管' : '已删除导线');
        return;
      }
      // ② 器件卡片上双击（未接线）→ 删除器件，等价右上角 ×
      const card = e.target.closest('.component-card');
      if (!card) return;
      // 避开交互热区/端子/删除钮/可编辑文字：这些有自己的单击语义，双击不应误删
      if (e.target.closest('.term-dot, .comp-zone, .del-btn, .comp-label[contenteditable="true"]')) return;
      const iid = card.dataset.instanceId;
      if (iid) this.removeComponent(iid, true);
    });
    // 导线右键 → 配置线标（自定义浮层面板，类似器件参数面板；器件卡片上的右键由组件自身处理）
    pw.addEventListener('contextmenu', e => {
      if (this._isLocked()) return;
      if (e.target.closest('.component-card')) return;
      const wid = this.wiring.checkWireHover(e.clientX, e.clientY);
      if (!wid) return;
      e.preventDefault();
      this._openWireLabelPanel(this.wiring.wires.get(wid), e.clientX, e.clientY);
    });

    // ★ 万用表
    document.getElementById('btnMeter').addEventListener('click', () => {
      if (this.multimeter && this.multimeter.active) {
        this._closeMeter();
      } else if (this._probeImages) {
        this.multimeter = new Multimeter(this.faultMgr, this._probeImages);
        const mp = document.getElementById('meterPanel');
        mp.style.display = ''; mp.style.left = 'auto'; mp.style.top = '60px'; mp.style.right = '240px';
      }
    });
    document.getElementById('meterClose').addEventListener('click', () => this._closeMeter());
    document.querySelectorAll('.meter-mode').forEach(btn => {
      btn.addEventListener('click', () => this.multimeter.setMode(btn.dataset.mode));
    });

    // ★ 排故模式：难度按钮按主配置 faultLevels 动态生成（数组下标 = 难度等级阈值，level ≤ 下标才候选）
    this._pickedWireId = null; this._pickedTermId = null;
    const levels = (this.config.rules && this.config.rules.faultLevels) || ['简单', '困难'];
    const menu = document.getElementById('faultMenu');
    menu.innerHTML = '';
    levels.forEach((name, idx) => {
      const b = document.createElement('button');
      b.className = 'btn-sm';
      b.textContent = name + '排故';
      b.addEventListener('click', () => this._enterFault(idx, name));
      menu.appendChild(b);
    });
    // 窗口右上角 ×：唯一退出排故入口（效果与"退出排故"一致）
    document.getElementById('btnFaultClose').addEventListener('click', () => this._exitFault());

    // 排故诊断: 单击导线（气路不设故障，忽略气管）
    pw.addEventListener('click', e => {
      if (!this.faultMgr.mode) return;
      const wid = this.wiring.checkWireHover(e.clientX, e.clientY);
      if (wid) { const w = this.wiring.wires.get(wid); if (w && w.media === 'pneumatic') return; this._pickedWireId = wid; this._pickedTermId = null; const label = w ? w.t1.parentInst.displayName() + '.' + (w.t1.tip || w.t1.id) + ' — ' + w.t2.parentInst.displayName() + '.' + (w.t2.tip || w.t2.id) : wid; document.getElementById('faultPick').textContent = '已选导线: ' + label; }
    });
    // 排故诊断: 点击端子
    pw.addEventListener('fault-diagnose', e => {
      if (!this.faultMgr.mode) return;
      const t = e.detail.terminal;
      this._pickedWireId = null; this._pickedTermId = t.parentInst.instanceId + '.' + t.id;
      document.getElementById('faultPick').textContent = '已选端子: ' + t.parentInst.displayName() + '.' + (t.tip || t.id);
    });
    // 排故确定按钮
    document.getElementById('btnFaultConfirm').addEventListener('click', () => {
      if (!this.faultMgr.mode) return;
      const r = this.faultMgr.checkDiagnosis(this._pickedWireId, this._pickedTermId);
      document.getElementById('faultResult').textContent = r.msg;
      this.showToast(r.msg, r.correct ? 'info' : 'warn');
      if (r.correct) {
        this.faultMgr.resolveFault();   // 清故障注入（电路恢复）但保持模式：窗口不自动关闭
        document.getElementById('btnFaultConfirm').disabled = true;   // 已排除，禁止重复确定
        this.setStatus('✅ 故障排除成功！点击“退出排故”或 × 结束');
      } else {
        // 记录错误选项（第N次 + 所选导线/端子），窗口随记录增多自动变高
        const pickEl = document.getElementById('faultPick');
        const desc = (pickEl.textContent || '').replace(/^已选(导线|端子): /, '') || '未选择';
        const row = document.createElement('div');
        row.textContent = '第' + this.faultMgr.attempts + '次 ✗ ' + desc;
        document.getElementById('faultLog').prepend(row);   // 倒序：最新记录在最上，第一次在最下
      }
    });

    // 窗口缩放
    let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { this.panel._resizePanel(); }, 200); });
  }

  /** 关闭万用表（关闭按钮 / 破坏性操作前自动关闭共用） */
  _closeMeter() {
    if (this.multimeter) { this.multimeter.destroy(); this.multimeter = null; }
    document.getElementById('meterPanel').style.display = 'none';
  }

  /** 退出排故模式（清除故障 + 恢复按钮/面板/锁定态） */
  _exitFault() {
    if (this.faultMgr && this.faultMgr.mode) {
      this.faultMgr.clearFault();
      this._faultUI();
      this.setStatus('已退出排故');
    }
    this._applyWireVisibility();   // 退出排故 → 回到隐藏连线开关的设置
  }

  /** 连线可见性：开关状态为主，排故模式强制显示（诊断要点击导线） */
  _applyWireVisibility() {
    const hidden = this._hideWires && !(this.faultMgr && this.faultMgr.mode);
    if (G.panel) {
      G.panel.hideWires = !!hidden;
      if (G.panel._redrawWires) G.panel._redrawWires();
    }
    const sw = document.getElementById('switchWires');
    if (sw) sw.classList.toggle('on', !this._hideWires);
    const lbl = document.getElementById('wiresLabel');
    if (lbl) lbl.textContent = this._hideWires ? '隐藏连线' : '显示连线';
  }

  /**
   * 线标配置面板（自定义浮层，替代系统 prompt；全局唯一，风格同 ParamPanel）。
   * 输入框 + 确定/清除/取消；Enter 确定、Esc 取消、点击面板外关闭。
   */
  _openWireLabelPanel(w, x, y) {
    if (this._wireLabelPanel) this._wireLabelPanel._close();   // 关闭旧面板（内部清理监听）
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;z-index:160;width:240px;background:#fff;border:1px solid #ccc;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.2);padding:12px;font-size:13px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;font-size:14px;margin-bottom:8px;';
    title.textContent = '✏ 线标 — ' + w.t1.id + ' → ' + w.t2.id;
    const input = document.createElement('input');
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;';
    input.value = w.label || '';
    input.placeholder = '输入线标（如 L1-1）';
    // 显示位置：两端 / 仅起点侧 / 仅终点侧（labelSide 持久化进工程快照）
    const sideRow = document.createElement('div');
    sideRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;';
    const sideLbl = document.createElement('span');
    sideLbl.textContent = '显示位置';
    sideLbl.style.cssText = 'color:#555;white-space:nowrap;';
    const sideSel = document.createElement('select');
    sideSel.style.cssText = 'flex:1;padding:4px 6px;border:1px solid #ccc;border-radius:6px;';
    for (const [v, t] of [['both', '两端'], ['start', '仅起点侧'], ['end', '仅终点侧']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (w.labelSide === v) o.selected = true;
      sideSel.appendChild(o);
    }
    sideRow.append(sideLbl, sideSel);
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;margin-top:10px;';
    const mkBtn = (txt, css, fn) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = css;
      b.addEventListener('click', fn);
      return b;
    };
    btns.append(
      mkBtn('确定', 'flex:1;padding:5px;border:none;border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer;', () => close(true)),
      mkBtn('清除', 'flex:1;padding:5px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;', () => { input.value = ''; close(true); }),
      mkBtn('取消', 'flex:1;padding:5px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;', () => close(false))
    );
    el.append(title, input, sideRow, btns);
    document.body.appendChild(el);
    // 定位在鼠标附近（append 后测量，clamp 防超视口）
    const ww = el.offsetWidth, wh = el.offsetHeight;
    el.style.left = Math.max(8, Math.min((x !== undefined ? x : window.innerWidth - ww - 24) - 8, window.innerWidth - ww - 8)) + 'px';
    el.style.top  = Math.max(8, Math.min((y !== undefined ? y : 70) - 8, window.innerHeight - wh - 8)) + 'px';

    const onOut = e => { if (!el.contains(e.target)) close(false); };
    const onKey = e => { if (e.key === 'Enter') close(true); else if (e.key === 'Escape') close(false); };
    const close = save => {
      document.removeEventListener('mousedown', onOut, true);
      document.removeEventListener('keydown', onKey);
      el.remove();
      if (this._wireLabelPanel === el) this._wireLabelPanel = null;
      if (save) { this._pushUndo(); w.label = input.value.trim() || null; w.labelSide = sideSel.value; this.panel._redrawWires(); }   // 线标改动可撤回
    };
    el._close = close;
    document.addEventListener('mousedown', onOut, true);
    document.addEventListener('keydown', onKey);
    this._wireLabelPanel = el;
    input.focus();
    input.select();
  }

  /* ---- 撤回/重做（快照式：结构操作可撤回，参数与运行状态不撤回） ---- */

  /** 记一次可撤回操作（操作前状态快照；空盘快照 = null，撤回即清盘）。
   *  同结构去重：只比结构（组件 id/位置、导线端点/线标），忽略 params 运行值——
   *  参数与运行状态本就不撤回，且运行值每 tick 变（JSON 全量比对既贵又失效）。 */
  _pushUndo() {
    if (!this.undoMgr || this._restoring) return;
    const snap = collectSnapshot();
    const top = this.undoMgr.undoStack[this.undoMgr.undoStack.length - 1];
    if (top !== undefined && this._sameStructure(top, snap)) return;   // 与栈顶同结构 → 跳过
    this.undoMgr.push(snap);
    this._syncUndoUI();
  }

  /** 快照结构比较（忽略 params）：组件 id 与位置 + 导线端点/线标 */
  _sameStructure(a, b) {
    if (!a || !b) return a === b;   // null === null（双空盘）
    if (a.components.length !== b.components.length || a.wires.length !== b.wires.length) return false;
    for (let i = 0; i < a.components.length; i++) {
      const x = a.components[i], y = b.components[i];
      if (x.id !== y.id || x.row !== y.row || x.left !== y.left || x.x !== y.x || x.y !== y.y) return false;
    }
    for (let i = 0; i < a.wires.length; i++) {
      const x = a.wires[i], y = b.wires[i];
      if (x.from[0] !== y.from[0] || x.from[1] !== y.from[1] ||
          x.to[0] !== y.to[0] || x.to[1] !== y.to[1]) return false;
      if ((x.label || null) !== (y.label || null)) return false;
      if ((x.labelSide || null) !== (y.labelSide || null)) return false;   // 线标显示位置也可撤回
    }
    return true;
  }

  /** 拖动按下记快照后若未移动，丢弃（撤回粒度 = 一次真实拖动） */
  _discardUndo() {
    if (!this.undoMgr) return;
    this.undoMgr.discardLast();
    this._syncUndoUI();
  }

  _syncUndoUI() {
    const bu = document.getElementById('btnUndo'), br = document.getElementById('btnRedo');
    if (bu) bu.disabled = !(this.undoMgr && this.undoMgr.canUndo());
    if (br) br.disabled = !(this.undoMgr && this.undoMgr.canRedo());
  }

  undo() {
    if (!this.undoMgr || !this.undoMgr.canUndo()) { this.setStatus('没有可撤回的操作'); this._syncUndoUI(); return; }
    const target = this.undoMgr.undo(collectSnapshot());   // 当前状态入 redo 栈
    this._restoreSnapshot(target);
    this._syncUndoUI();
  }

  redo() {
    if (!this.undoMgr || !this.undoMgr.canRedo()) { this.setStatus('没有可重做的操作'); this._syncUndoUI(); return; }
    const target = this.undoMgr.redo(collectSnapshot());
    this._restoreSnapshot(target);
    this._syncUndoUI();
  }

  /**
   * 恢复快照（撤回/重做共用）：
   *   - 存活实例（LCS 对齐到当前实例）→ 保持当前 params（参数/运行状态不撤回）；
   *   - 快照独有（被删器件）→ 用快照 params 放置；
   *   - 当前独有（新加器件）→ 撤回时自然消失；
   *   - 导线/线标全量恢复；bind 引用（当前 params 里的 instanceId）重映射到新实例。
   */
  _restoreSnapshot(snap) {
    console.log('[undo] 恢复：快照组件=' + (snap && snap.components ? snap.components.length : 0)
      + ' 快照导线=' + (snap && snap.wires ? snap.wires.length : 0)
      + ' 当前组件=' + this.panel.instances.size + ' 当前导线=' + this.wiring.wires.size);
    // 预检快照（器件定义/导线端点/介质）：失败则完全不动当前版面（排故/万用表也不动）——
    // 防止"先清盘、重建中途失败"把用户版面清空且 undo 链已断
    if (snap && Array.isArray(snap.components) && snap.components.length) {
      const verr = this._validateLayoutDef(snap);
      if (verr) {
        console.error('[undo] 快照校验失败，放弃恢复（保持当前版面）:', verr);
        this.setStatus('撤回失败');
        return false;
      }
    }
    this._prepareForCleanup();
    if (!snap || !Array.isArray(snap.components) || !snap.components.length) {
      this.wiring.clearAllWires(); this.panel.clearAll();
      this.setStatus('已撤回');
      return true;
    }
    const curInsts = [...this.panel.instances.values()];
    const pairs = lcsAlign(snap.components.map(c => c.id), curInsts.map(i => i.definition.id));
    const overrideParams = new Array(snap.components.length).fill(null);
    const bindIdMap = new Map();   // 当前 instanceId → 快照组件索引（新实例 = placed[索引]）
    for (const [i, j] of pairs) {
      overrideParams[i] = curInsts[j].params;
      bindIdMap.set(curInsts[j].instanceId, i);
    }
    this._restoring = true;
    try {
      this.wiring.clearAllWires();
      this.panel.clearAll();
      const ok = this.applyLayout(snap, { noUndo: true, overrideParams, bindIdMap });
      this.setStatus(ok ? '已撤回' : '撤回失败');
      return ok;
    } finally {
      this._restoring = false;
    }
  }

  /** 撤回恢复时把存活实例 params 里的 bind 引用（'inst_N' 字符串）重映射到新实例 id（目标被删 → null） */
  _rewriteBindIds(params, def, bindIdMap, placed) {
    for (const p of def.params) {
      if (p.type !== 'bind') continue;
      const v = params[p.id];
      if (typeof v === 'string' && v.startsWith('inst_')) {
        const idx = bindIdMap.get(v);
        params[p.id] = idx !== undefined && placed[idx] ? placed[idx].instanceId : null;
      }
    }
  }

  /**
   * 破坏性操作前的统一清理：主动退出排故 + 关闭万用表。
   * 用于切换线槽、导入工程/场景、清除导线、清除元件——避免诊断/测量状态残留。
   */
  _prepareForCleanup() {
    this._exitFault();
    this._closeMeter();
  }

  /** 排故模式激活时锁定接线/删除/移动。万用表不限制 */
  _isLocked() { return this.faultMgr && this.faultMgr.mode; }

  async _loadImage(fileName) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败: ' + fileName));
      img.src = './' + fileName;
    });
  }

  /** 无线槽模式下行数输入不可调节（始终显示，禁用态） */
  _syncRowInputVisible() {
    const lbl = document.getElementById('rowCountLabel');
    const input = document.getElementById('rowCount');
    if (!lbl || !input) return;
    const on = this.panel.useDuct;
    input.disabled = !on;
    lbl.style.opacity = on ? '' : '0.5';
    lbl.style.cursor = on ? '' : 'not-allowed';
  }

  /** 进入排故模式（maxLevel = faultLevels 数组下标；name = 难度按钮名） */
  _enterFault(maxLevel, name) {
    const desc = this.faultMgr.setRandomFault(maxLevel);
    if (!desc) { this.showToast('无候选故障点（请先接线）', 'warn'); return; }
    document.getElementById('faultTitle').textContent = '排故模式（' + name + '）';
    document.getElementById('faultPick').textContent = '';
    document.getElementById('faultResult').textContent = '';
    document.getElementById('faultLog').innerHTML = '';   // 新一轮排故清空错误记录
    document.getElementById('btnFaultConfirm').disabled = false;   // 新一轮排故恢复确定按钮
    this._pickedWireId = null; this._pickedTermId = null;
    this._faultUI(); this.setStatus('排故: 单击导线或点击端子标记故障点');
    this._applyWireVisibility();   // 排故模式强制显示连线（诊断要点击导线）
  }

  _faultUI() {
    const m = this.faultMgr.mode;
    document.getElementById('faultPanel').style.display = m ? '' : 'none';
    document.getElementById('panelWrapper').classList.toggle('fault-active', m);
  }

  _buildColorPicker() {
    // 电路导线颜色
    const colors = this.config.wiring.electrical.colors; let h = '';
    for (const c of colors) h += '<span class="color-swatch' + (c === this.wiring.currentColor ? ' active' : '') + '" style="background:' + c + '" data-color="' + c + '" title="导线颜色"></span>';
    document.getElementById('colorPicker').innerHTML = h;
    document.getElementById('colorPicker').addEventListener('click', e => { const sw = e.target.closest('.color-swatch'); if (!sw) return; document.getElementById('colorPicker').querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active')); sw.classList.add('active'); this.wiring.setColor(sw.dataset.color); });
    // 气管颜色（气路独立选色：黑/蓝）
    const pcfg = this.config.wiring.pneumatic || { colors: ['#2f6fd0', '#1f2c34'] };
    const pcolors = pcfg.colors || ['#2f6fd0', '#1f2c34'];
    let ph = '';
    for (const c of pcolors) ph += '<span class="color-swatch' + (c === this.wiring.currentPneuColor ? ' active' : '') + '" style="background:' + c + '" data-color="' + c + '" title="气管颜色"></span>';
    document.getElementById('colorPickerPneu').innerHTML = ph;
    document.getElementById('colorPickerPneu').addEventListener('click', e => { const sw = e.target.closest('.color-swatch'); if (!sw) return; document.getElementById('colorPickerPneu').querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active')); sw.classList.add('active'); this.wiring.setPneuColor(sw.dataset.color); });
  }

  handleLibraryDrop(defId, rowIndex) {
    if (String(defId).startsWith('scene:')) { this._placeScene(String(defId).slice(6), rowIndex); return; }
    const def = this.definitions.get(defId); if (!def) return; this._pushUndo(); const inst = this.panel.addInstance(def, rowIndex); if (inst) { if (typeof inst.open3D === 'function') inst.open3D(); this.setStatus('已放置: ' + def.name + ' → 第' + (inst.rowIndex + 1) + '行'); }
  }
  handleLibraryDropAt(defId, x, y) {
    if (String(defId).startsWith('scene:')) { this._placeScene(String(defId).slice(6)); return; }
    const def = this.definitions.get(defId); if (!def) return; this._pushUndo(); const inst = this.panel.addFreeInstance(def, x, y); if (inst) { if (typeof inst.open3D === 'function') inst.open3D(); this.setStatus('已放置: ' + def.name); }
  }

  /**
   * 放置场景组合：场景定义 = 配置文件里的"布局定义"，与工程导入共用统一引擎 applyLayout。
   * @param {string} sceneId 场景 id
   * @param {number} [startRow] 有线槽模式的起始行（行拖放时传入，缺省 0）
   */
  _placeScene(sceneId, startRow = 0) {
    const scene = this.scenes.find(s => s.id === sceneId);
    if (!scene) { this.showToast('场景不存在: ' + sceneId, 'warn'); return; }
    const layoutDef = {
      name: scene.name,
      layout: scene.layout || null,
      components: scene.components || [],
      wires: scene.wires || [],
    };
    // 有线槽拖到指定行：仅对"无显式 row"的组件做起始行偏移（有显式 row 的按配置）
    if (startRow > 0 && this.panel.useDuct) {
      layoutDef.components = layoutDef.components.map(c =>
        (c.row !== undefined ? c : { ...c, row: startRow }));
    }
    this.applyLayout(layoutDef);
  }

  /**
   * 布局定义预检（导入/撤回恢复前调用，先于任何破坏性动作）：
   * 组件 id 已定义、导线组件索引/端子 id 存在、两端介质一致。
   * @returns {string|null} 错误信息（null = 通过）
   */
  _validateLayoutDef(layoutDef) {
    const comps = Array.isArray(layoutDef.components) ? layoutDef.components : [];
    const wires = Array.isArray(layoutDef.wires) ? layoutDef.wires : [];
    for (const c of comps) {
      if (!c || !this.definitions.has(c.id)) return '器件未定义: ' + (c && c.id);
    }
    for (const w of wires) {
      if (!Array.isArray(w.from) || !Array.isArray(w.to)) return '导线端点格式错误: ' + JSON.stringify(w);
      const a = comps[w.from[0]], b = comps[w.to[0]];
      if (!a || !b) return '导线索引越界: ' + JSON.stringify(w);
      const t1 = this._findTerminalMedia(this.definitions.get(a.id), w.from[1]);
      const t2 = this._findTerminalMedia(this.definitions.get(b.id), w.to[1]);
      if (!t1 || !t2) return '端子未找到: ' + JSON.stringify(w);
      if (t1 !== t2) return '电路与气路端子不能混接: ' + JSON.stringify(w);
    }
    return null;
  }

  /** 端子定义查找：返回端子介质（'electrical'/'pneumatic'）或 null（未找到） */
  _findTerminalMedia(def, termId) {
    if (!def) return null;
    const t = def.flattenTerminals().find(t => t.id === termId);
    return t ? t.type : null;
  }

  /**
   * 统一布局引擎（场景组合 + 工程导入共用）。
   * layoutDef = {
   *   name?, layout?: 'duct'|'free',          // 显式布局优先；缺省由组件位置决定/沿用当前模式
   *   components: [{ id, row?, left?, x?, y?, params?, label? }],
   *   wires:      [{ from:[组件索引,端子id], to:[...], color?, media? }]
   * }
   * 规则：
   *   - 组件只提供 row/left → 自动切有线槽；只提供 x/y → 自动切无线槽；两者都提供 → 用当前模式；
   *   - 有线槽：row/left 精确放置（冲突→向右→向下→自动加行 fallback）；无线槽：防重叠最近空位 + 操作区不足自动扩充；
   *   - 导线一律 auto 敷设（media 缺省 electrical；pneumatic 提示暂不支持并跳过）；
   *   - 恢复 params/label；bind 参数持久化值 "@组件索引" 在全部放置完成后解析为新 instanceId；
   *   - 任一环节失败 → 回滚清空。
   * @returns {boolean} 是否成功
   */
  applyLayout(layoutDef, opts = {}) {
    this._prepareForCleanup();   // 排故中先退出、万用表先关闭（导入是破坏性操作）
    if (this.panel.instances.size > 0 || this.wiring.wires.size > 0) {
      this.showToast('配电盘非空，请先清除元件和连线再导入/放置', 'warn'); return false;
    }
    const comps = Array.isArray(layoutDef.components) ? layoutDef.components : [];
    const wires = Array.isArray(layoutDef.wires) ? layoutDef.wires : [];
    if (!comps.length) { this.showToast('布局定义为空', 'warn'); return false; }
    // 预检（器件定义/导线索引/端子存在/介质一致）——先于记快照与任何破坏性动作，
    // 避免失败操作留下多余撤回步、也避免"撤回恢复时先清盘再重建失败"
    const verr = this._validateLayoutDef(layoutDef);
    if (verr) { this.showToast('布局校验失败: ' + verr, 'warn'); return false; }
    if (!opts.noUndo) this._pushUndo();   // 场景/工程导入整体可撤回（此时盘空 → 快照为 null = 撤回即清盘）

    // ① 目标布局模式：显式 layout 优先；否则按首个组件提供的位置类型；都无 → 沿用当前模式
    const c0 = comps[0];
    const hasRow = c0.row !== undefined && c0.left !== undefined;
    const hasXY  = c0.x !== undefined && c0.y !== undefined;
    let target;
    if (layoutDef.layout === 'duct' || layoutDef.layout === 'free') target = layoutDef.layout;
    else if (hasRow && !hasXY) target = 'duct';
    else if (!hasRow && hasXY) target = 'free';
    else target = this.panel.useDuct ? 'duct' : 'free';
    const targetDuct = target === 'duct';

    // ② 切换模式（空盘可切）+ 工具栏开关态同步
    if (this.panel.useDuct !== targetDuct) {
      this.panel.setUseDuct(targetDuct);
      const sw = document.getElementById('switchDuct'), lbl = document.getElementById('ductLabel');
      if (sw && lbl) { sw.classList.toggle('on', targetDuct); lbl.textContent = targetDuct ? '有线槽' : '无线槽'; }
      this._syncRowInputVisible();
    }

    const prevMode = this.wiring.connectMode;
    const prevColor = this.wiring.currentColor;
    this.wiring.connectMode = 'auto';   // 导线一律自动敷设（蓝图约定：路径可随端子位置推导）
    const placed = [];
    try {
      // ① 放置全部器件（参数恢复统一在 ②：bind 引用 "@组件索引" 需全部放置完成后才能解析）
      let cursorRow = 0;
      for (const c of comps) {
        const def = this.definitions.get(c.id);
        if (!def) throw new Error('器件未定义: ' + c.id);
        let inst;
        if (this.panel.useDuct) {
          if (c.row !== undefined && c.left !== undefined) {
            inst = this.panel.addInstanceAt(def, c.row, c.left);        // 精确 + fallback
          } else if (c.row !== undefined) {
            inst = this.panel.addInstance(def, c.row);                  // 指定行 first-fit
          } else {
            inst = this.panel.addInstance(def, cursorRow);              // 顺序排（旧场景行为）
          }
          if (inst) cursorRow = inst.rowIndex;
        } else {
          const s = def.size || { width: def.dispW() + 12, height: def.dispH() + 10 };
          const px = c.x !== undefined ? c.x : 10, py = c.y !== undefined ? c.y : 10;
          this.panel._ensureFreeArea(px + s.width, py + s.height);      // 操作区不足自动扩充
          inst = this.panel.addFreeInstance(def, px + s.width / 2, py + s.height / 2);
        }
        if (!inst) throw new Error('器件放置失败: ' + c.id);
        placed.push(inst);
      }
      // ② 恢复参数 / 标签（params 统一承载一切：状态键与参数同容器；scan 下个 tick 重算动态值，瞬时初值无害）
      //    opts.overrideParams[i]（撤回恢复用）：存活实例的当前 params（参数不撤回），bind 值经 _rewriteBindIds 重映射
      for (let i = 0; i < placed.length; i++) {
        const c = comps[i], inst = placed[i];
        let params;
        if (opts.overrideParams && opts.overrideParams[i]) {
          params = { ...opts.overrideParams[i] };
          this._rewriteBindIds(params, inst.definition, opts.bindIdMap, placed);
        } else {
          params = resolveParamsForImport(c, i, placed);
        }
        if (params) { Object.assign(inst.params, params); if (inst.onParamsChanged) inst.onParamsChanged(); }
        // 名称走 params.name（标牌参数），不再恢复独立 label 字段
        inst.refreshDisplay();
      }
      for (const w of wires) {
        const a = placed[w.from[0]], b = placed[w.to[0]];
        if (!a || !b) throw new Error('导线索引越界: ' + JSON.stringify(w));
        const t1 = a.terminals.find(t => t.id === w.from[1]);
        const t2 = b.terminals.find(t => t.id === w.to[1]);
        if (!t1 || !t2) throw new Error('端子未找到: ' + JSON.stringify(w));
        if (t1.type !== t2.type) throw new Error('电路与气路端子不能混接: ' + JSON.stringify(w));   // 介质一致性校验
        // 介质由端子类型派生（electrical/pneumatic 不可混接已在接线校验保证）；颜色按导线记录覆盖
        const nw = this.wiring._createWire(t1, t2, w.color ? { color: w.color } : {});
        if (nw && w.label) { nw.label = String(w.label); if (w.labelSide) nw.labelSide = String(w.labelSide); }   // 恢复线标与显示位置
      }
      const name = layoutDef.name || '布局';
      const nElec = wires.filter(w => (w.media || 'electrical') !== 'pneumatic').length;
      const nPneu = wires.length - nElec;
      this.setStatus('已导入「' + name + '」: ' + placed.length + ' 器件 / ' + nElec + ' 导线'
        + (nPneu ? ' / ' + nPneu + ' 气管' : ''));
      return true;
    } catch (err) {
      console.error('布局放置失败:', err);
      this.wiring.clearAllWires(); this.panel.clearAll();
      this.showToast('布局放置失败: ' + err.message, 'warn');
      return false;
    } finally {
      this.wiring.connectMode = prevMode;   // 恢复用户接线模式
      this.wiring.currentColor = prevColor; // 恢复用户工具栏选色
    }
  }
  onInstanceAdded(i) { if (i.definition.isSingleton()) this.library.updateSingleton(i.definition.id, true); this._sum(); }
  onInstanceRemoved(i) { if (i.definition.isSingleton()) this.library.updateSingleton(i.definition.id, false); this._sum(); }
  onAllCleared() { for (const d of this.definitions.values()) { if (d.isSingleton()) this.library.updateSingleton(d.id, false); } this._sum(); }

  removeComponent(iid, skipConfirm) {
    if (this._isLocked()) { this.showToast('当前模式下禁止删除器件', 'warn'); return; }
    const inst = this.panel.instances.get(iid); if (!inst) return;
    if (inst.hasWires) { this.showToast('已接线器件不可删除', 'warn'); return; }
    if (!skipConfirm && !confirm('确定删除「' + inst.displayName() + '」？')) return;
    this._pushUndo();   // 撤回：删除前记快照
    this.panel.removeInstance(iid);
  }

  _sum() { const c = this.panel.instances.size; const t = {}; for (const i of this.panel.instances.values()) t[i.definition.name] = (t[i.definition.name] || 0) + 1; const p = Object.entries(t).map(([k, v]) => k + '×' + v).join(', '); document.getElementById('statusText').textContent = c > 0 ? '已放置 ' + c + ' 个: ' + p : '就绪'; }
  setStatus(m) { document.getElementById('statusText').textContent = m; }
  showToast(m, type) { const el = document.createElement('div'); el.className = 'toast ' + (type || 'info'); el.textContent = m; document.body.appendChild(el); setTimeout(() => el.remove(), 2200); }
}

window.addEventListener('DOMContentLoaded', () => { new App().init(); });
