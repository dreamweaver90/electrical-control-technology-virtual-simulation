/**
 * 万用表 — 每次打开重建，关闭销毁。
 * 笔尖坐标来自配置 tipX/tipY，用于端子定位。
 */
import { G } from './globals.js';
import { buildGraph, isTerminalLive, pairKeyOf } from './graph.js';

export class Multimeter {
  constructor(faultManager, imgs) {
    this.fm = faultManager;
    this.active = true;
    this.mode = 'resistance';
    this._imgs = imgs;
    this._audioCtx = null;   // 蜂鸣（导通测试：电阻 < 10Ω 响）
    this._beeper = null;
    // 表笔初始位置基于可见区宽度（无线槽 _pw = 操作区宽×2，探针会落在屏幕外）
    const vw = (G.panel && G.panel.wrapperEl) ? G.panel.wrapperEl.clientWidth : 1200;
    this.red   = { el:null, term:null, x:vw-350, y:280, w:imgs.redW, h:imgs.redH, tipX:imgs.redTipX, tipY:imgs.redTipY };
    this.black = { el:null, term:null, x:vw-180, y:280, w:imgs.blackW, h:imgs.blackH, tipX:imgs.blackTipX, tipY:imgs.blackTipY };
    this._lastResult = 'OL';
    this._drag = null; this._offX = 0; this._offY = 0;
    this._createProbes(); this._startDrag(); this._setModeUI('resistance');
  }

  /** 面板重建（切线槽模式）后重挂探针：旧 panelEl 被 remove，探针需移到新 panelEl */
  _reattach() {
    const panelEl = G.panel && G.panel.panelEl;
    if (!panelEl) return;
    for (const c of ['red', 'black']) {
      const p = this[c];
      if (p.el && p.el.parentElement !== panelEl) panelEl.appendChild(p.el);
    }
  }

  destroy() {
    this.active = false;
    this._stopBeep();
    if (this.red.el)  { this.red.el.remove();  this.red.el = null; }
    if (this.black.el) { this.black.el.remove(); this.black.el = null; }
    document.removeEventListener('mousemove', this._onMM);
    document.removeEventListener('mouseup', this._onMU);
    // 摘除挂在常驻 panelEl 上的捕获阶段监听（此前每次开关万用表累积一个）
    const panelEl = G.panel && G.panel.panelEl;
    if (panelEl && this._onMD) panelEl.removeEventListener('mousedown', this._onMD, true);
    // 拖拽中关闭万用表：清理残留的禁用光标状态
    document.body.classList.remove('panel-dragging');
  }

  setMode(m) { this.mode = m; this._setModeUI(m); if (m !== 'resistance') this._stopBeep(); this._refresh(); }

  /* ---- 蜂鸣（导通测试：电阻 < 10Ω 持续响） ---- */
  _startBeep() {
    if (this._beeper) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this._audioCtx || (this._audioCtx = new AC());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square'; osc.frequency.value = 2000;
      gain.gain.value = 0.06;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      this._beeper = osc;
    } catch (e) { /* 音频不可用则静默 */ }
  }
  _stopBeep() {
    if (this._beeper) {
      try { this._beeper.stop(); } catch (e) {}
      this._beeper = null;
    }
  }
  _setModeUI(m) {
    document.querySelectorAll('.meter-mode').forEach(b => { b.classList.remove('active'); b.style.background='#3d3d54'; b.style.borderColor='#555'; });
    const btn = document.querySelector('.meter-mode[data-mode="'+m+'"]');
    if (btn) { btn.classList.add('active'); btn.style.background='#4a90d9'; btn.style.borderColor='#4a90d9'; }
  }

  /* ---- 表笔 DOM ---- */
  /**
   * 探针挂在 panelEl（缩放容器）内：坐标全部用面板逻辑坐标（与 panelPos 同坐标系），
   * 随面板一起缩放/滚动，无需 scroll/zoom 换算；拖动与吸附天然一致。
   */
  _createProbes() {
    const panelEl = G.panel ? G.panel.panelEl : null;
    if (!panelEl) return;
    for (const p of [this.red, this.black]) {
      const img = document.createElement('img');
      img.src = this._imgs[p===this.red?'red':'black'].src; img.draggable = false;
      img.style.cssText = 'position:absolute;z-index:20;width:'+p.w+'px;height:'+p.h+'px;left:'+p.x+'px;top:'+p.y+'px';
      panelEl.appendChild(img); p.el = img;
    }
  }

  /* ---- 拖动：笔尖 (x+tipX, y+tipY) 用于端子检测（panel 逻辑坐标） ---- */
  /** 鼠标事件 → 面板逻辑坐标（缩放/滚动适配） */
  _clientToPanel(e) {
    const panelEl = G.panel && G.panel.panelEl;
    const rect = panelEl.getBoundingClientRect();
    const z = (G.panel && G.panel.zoom) || 1;
    return {
      x: (e.clientX - rect.left) / z + panelEl.scrollLeft / z,
      y: (e.clientY - rect.top)  / z + panelEl.scrollTop  / z,
    };
  }

  _startDrag() {
    const panelEl = G.panel ? G.panel.panelEl : null;
    if (!panelEl) return;
    panelEl.addEventListener('mousedown', this._onMD = e => {
      const { x: sx, y: sy } = this._clientToPanel(e);
      for (const c of ['red','black']) {
        const p = this[c];
        if (p.el && sx >= p.x && sx <= p.x + p.w && sy >= p.y && sy <= p.y + p.h) {
          this._drag = c; this._offX = sx - p.x; this._offY = sy - p.y;
          document.body.classList.add('panel-dragging');   // 拖动表笔：禁用盘上导线/热区/端子的悬停光标效果
          e.preventDefault(); e.stopPropagation(); return;
        }
      }
    }, true);

    this._onMM = e => {
      if (!this._drag) return;
      const pt = this._clientToPanel(e);
      const x = pt.x - this._offX;
      const y = pt.y - this._offY;
      const p = this[this._drag]; p.x = x; p.y = y;   // 逻辑坐标（吸附检测用）
      if (p.el) { p.el.style.left = x+'px'; p.el.style.top = y+'px'; }   // panel 内直接定位，随面板缩放
    };
    document.addEventListener('mousemove', this._onMM);

    this._onMU = () => {
      document.body.classList.remove('panel-dragging');   // 表笔拖动结束（防御：未拖动也清）
      if (!this._drag) return;
      const p = this[this._drag];
      // ★ 笔尖坐标
      const tipX = p.x + p.tipX, tipY = p.y + p.tipY;
      const nearest = this._findTerm(tipX, tipY);
      if (nearest) {
        p.term = nearest;
        const tp = nearest.panelPos();
        // 笔尖对准端子中心
        p.x = tp.x - p.tipX; p.y = tp.y - p.tipY;
        if (p.el) { p.el.style.left = p.x+'px'; p.el.style.top = p.y+'px'; }
      } else { p.term = null; }
      this._drag = null; this._refresh();
    };
    document.addEventListener('mouseup', this._onMU);
  }

  _findTerm(tipX, tipY) {
    let b = null, bd = 1e9;
    for (const i of G.panel.instances.values()) {
      for (const t of i.terminals) {
        if (t.isHidden) continue;
        const tp = t.panelPos(), d = Math.hypot(tipX - tp.x, tipY - tp.y);
        if (d < t.hitRadius && d < bd) { bd = d; b = t; }
      }
    }
    return b;
  }

  /* ---- 刷新 ---- */
  _refresh() {
	if (!this.active) return;
	
	if(this.mode === 'resistance'){
		let rawR = null;   // 导通测试蜂鸣：电阻 < 10Ω 响
		if(this._isLive(this.red.term) || this._isLive(this.black.term)){
			this._lastResult = '带电';
		}else if((!this.red.term) || (!this.black.term)){
			this._lastResult = 'OL';
		}else{
			rawR = this._resist(this.red.term, this.black.term, true);
			this._lastResult = (rawR === Infinity) ? 'OL' : (rawR < 0.1 ? '0.0 Ω' : rawR.toFixed(1) + ' Ω');
		}
		if (rawR !== null && rawR < 10) this._startBeep();
		else this._stopBeep();
	}else{
		if(!this.red.term || !this.black.term){
			this._lastResult = '0.0V';
		}else{
			this._lastResult = this._measure(this.red.term, this.black.term);
		}
	}
	
    const el = document.getElementById('meterDisplay');
    if (el) el.textContent = this._lastResult;
  }

  /** 端子是否带电（万用表安全提示用）：与任一 working 电源源端子连通即带电（isTerminalLive，不含故障） */
  _isLive(term) {
    return !!term && isTerminalLive(term);
  }

  _measure(t1, t2) {
    if (this.mode === 'ac_voltage') return this._volt(t1, t2, 'ac');
    if (this.mode === 'dc_voltage') return this._volt(t1, t2, 'dc');
    return '---';
  }

_resist(t1, t2, raw = false) {
  // ========== 常量配置 ==========
  const MAX_ITER = 20;          // 最大化简迭代轮次，防止环路死循环
  const SHORT_THRESHOLD = 0.1;  // 小于该值统一显示0.0 Ω
  const EPS = 1e-9;             // 浮点精度容错

  // ========== 工具函数：端子唯一标识 ==========
  // 单端键；双端无向边键统一复用 graph.js 的 pairKeyOf（与求解器/图构建同源）
  const getTermKey = (term) => `${term.parentInst.instanceId}|${term.id}`;

  // ========== 阶段1：压缩0电阻通路（导线+触点+恒连，含故障注入） ==========
  const uf = buildGraph();
  const nodeStart = uf.find(t1);
  const nodeEnd = uf.find(t2);
  // 两点等电位，纯短路无负载
  if (nodeStart === nodeEnd) return raw ? 0 : '0.0 Ω';

  // ========== 阶段2：提取全部有效电阻边 ==========
  // 统一复用 numericBranches()（与数值求解同一支路来源）：
  //   loads 支路 zdc = params.dcResistance（电机/线圈/指示灯）或 z.re；computed（电机）已算好；
  //   sensors 支路 z.re = resistance；闭合 contacts 支路 z.re = 触头电阻；
  //   open 故障（对级）已由 numericBranches 跳过；contacts 对级 open（exclude）在此排除。
  // 欧姆档一律用直流电阻（zdc 优先，缺省 z.re）。
  let resistorEdges = [];
  const isExPair = (inst, a, b) => {
    const mod = this.fm ? this.fm.getFaultModifications(inst) : { exclude: [] };
    return mod.exclude.some(p => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a));
  };
  for (const inst of G.panel.instances.values()) {
    for (const b of inst.numericBranches()) {
      if (!b || !b.a || !b.b) continue;
      const n1 = uf.find(b.a), n2 = uf.find(b.b);
      if (n1 === n2) continue;
      if (b.key && b.key.startsWith('contact:') && isExPair(inst, b.a, b.b)) continue;
      const r = b.zdc ? b.zdc.re : b.z.re;
      if (!r || r <= 0) continue;
      resistorEdges.push({ n1, n2, r });
    }
  }
  // 无任何负载电阻，开路
  if (resistorEdges.length === 0) return raw ? Infinity : 'OL';

  // ========== 阶段3：循环迭代化简（并联 → 串联） ==========
  let changed;
  let iterCount = MAX_ITER;
  do {
    changed = false;
    iterCount--;
    if (iterCount <= 0) break;

    // 3.1 并联合并：同一节点对多条电阻合并
    const parallelGroupMap = new Map();
    for (const edge of resistorEdges) {
      const key = pairKeyOf(edge.n1, edge.n2);
      if (!parallelGroupMap.has(key)) parallelGroupMap.set(key, []);
      parallelGroupMap.get(key).push(edge);
    }

    const afterParallel = [];
    for (const group of parallelGroupMap.values()) {
      if (group.length === 1) {
        afterParallel.push(group[0]);
        continue;
      }
      // 多电阻并联，电导求和
      let totalG = 0;
      for (const e of group) totalG += 1 / e.r;
      const eqR = 1 / totalG;
      afterParallel.push({ n1: group[0].n1, n2: group[0].n2, r: eqR });
      changed = true;
    }
    resistorEdges = afterParallel;

       // 3.2 串联合并：处理二度中间节点（彻底修复多级串联互斥全部跳过BUG）
    // 构建邻接表
	//每个节点都是一个键，对象是数组，元素是对端电阻节点
    const adjTable = new Map();
    for (const e of resistorEdges) {
      if (!adjTable.has(e.n1)) adjTable.set(e.n1, []);
      if (!adjTable.has(e.n2)) adjTable.set(e.n2, []);
      adjTable.get(e.n1).push({ other: e.n2, r: e.r });
      adjTable.get(e.n2).push({ other: e.n1, r: e.r });
    }

    const mergedMidNodes = new Set();
    const newSeriesEdges = [];
    // 第一步：收集所有符合二度条件的候选中间节点
    const candidateMergeNodes = [];
	/*元素是{
          node,中间节点
          uniqueOthers,map，对象数量必为2，键是两头节点唯一id,值为 { node: item.other 两头节点对象, sumR: 0}
          key: getTermKey(node) 中间节点id
        }
	*/
    for (const [node, neighborList] of adjTable) {
      if (node === nodeStart || node === nodeEnd) continue;

      const uniqueOthers = new Map();
      for (const item of neighborList) {
        const k = getTermKey(item.other);
        if (!uniqueOthers.has(k)) {
          uniqueOthers.set(k, { node: item.other, sumR: 0});
        }
        const info = uniqueOthers.get(k);
        info.sumR += item.r;
      }
      if (uniqueOthers.size === 2) {
        candidateMergeNodes.push({
          node,
          uniqueOthers,
          key: getTermKey(node)
        });
      }
    }
    // 建立候选节点key集合，快速判断邻居是否为候选
    const candidateKeySet = new Set(candidateMergeNodes.map(item => item.key));

    // 第二步：遍历候选节点，单向筛选合并（key小的优先合并，避免双向互斥）
    for (const item of candidateMergeNodes) {
      const { node, uniqueOthers, key: nodeKey } = item;
      const [infoA, infoB] = uniqueOthers.values();
      const keyA = getTermKey(infoA.node);
      const keyB = getTermKey(infoB.node);

      // 判断两个邻居是否是本轮待合并候选
      const neighborAIsCandidate = candidateKeySet.has(keyA);
      const neighborBIsCandidate = candidateKeySet.has(keyB);

      // 核心规则：
      // 若邻居是候选，且邻居节点key < 当前节点key → 本轮放弃，留给邻居先合并
      let skipThisNode = false;
      if (neighborAIsCandidate && keyA < nodeKey) skipThisNode = true;
      if (neighborBIsCandidate && keyB < nodeKey) skipThisNode = true;
      if (skipThisNode) continue;

      // 允许本轮合并
      mergedMidNodes.add(node);
      const totalR = infoA.sumR + infoB.sumR;
      newSeriesEdges.push({ n1: infoA.node, n2: infoB.node, r: totalR });
      changed = true;
    }

    // 重建边列表：新串联桥接边 + 不包含合并中间节点的旧边
    // 不进行去重：同节点对的多条边留给下一轮 3.1 并联合并处理
    if (changed) {
      const finalEdges = [...newSeriesEdges];

      for (const e of resistorEdges) {
        // 边两端任意一个是被合并的中间节点，丢弃
        if (mergedMidNodes.has(e.n1) || mergedMidNodes.has(e.n2)) continue;
        finalEdges.push(e);
      }
      resistorEdges = finalEdges;
    }
  } while (changed && iterCount > 0);

  // ========== 阶段4：迭代结束后，再做一次全局并联合并（兜底） ==========
  const finalGroup = new Map();
  for (const e of resistorEdges) {
    const k = pairKeyOf(e.n1, e.n2);
    if (!finalGroup.has(k)) finalGroup.set(k, []);
    finalGroup.get(k).push(e);
  }
  let finalEdges = [];
  for (const g of finalGroup.values()) {
    if (g.length === 1) {
      finalEdges.push(g[0]);
      continue;
    }
    let gSum = 0;
    g.forEach(e => gSum += 1 / e.r);
    finalEdges.push({ n1: g[0].n1, n2: g[0].n2, r: 1 / gSum });
  }

  // ========== 阶段5：查找起点-终点之间等效电阻 ==========
  const targetEdgeKey = pairKeyOf(nodeStart, nodeEnd);
  let eqResistance = null;
  for (const e of finalEdges) {
    if (pairKeyOf(e.n1, e.n2) === targetEdgeKey) {
      eqResistance = e.r;
      break;
    }
  }

  if (eqResistance === null) return raw ? Infinity : 'OL';
  // 浮点极小容错
  if (eqResistance < SHORT_THRESHOLD + EPS) {
    return raw ? 0 : '0.0 Ω';
  }
  return raw ? eqResistance : `${eqResistance.toFixed(1)} Ω`;
}

  /**
   * 电压测量 —— 直接读求解器结果（MNA 相量求解，与面板电压表读数完全一致）。
   *   AC 档：两端均在同一 AC 岛 → 相量差模长（L1-L2 自动 = 线电压、星点/分压由求解精确给出）；
   *   DC 档：两端均在同一 DC 岛 → 红笔−黑笔有符号差。
   *   任一端未定义（无源岛/悬空/混域）、两端不同岛（如两个独立整流器输出之间，电位差无定义）
   *   或档位与岛域不匹配 → '---'。
   */
  _volt(t1, t2, vtype) {
    const solve = G.solveResult;
    if (!solve) return '---';
    const p1 = solve.potential(t1), p2 = solve.potential(t2);
    if (!p1 || !p2) return '---';
    if (!solve.sameReference(t1, t2)) return '---';   // 不同电位参考系（独立电源之间）→ 电位差无定义
    const d1 = solve.domainOf(t1);
    const wantAC = vtype === 'ac';
    if (d1.startsWith('ac') !== wantAC) return '---';   // 档位与岛域不匹配（AC 档测 DC 电路等）
    if (wantAC) {
      const mag = Math.hypot(p1.re - p2.re, p1.im - p2.im);
      if (mag < 1) return '0V';
      return Math.round(mag) + 'V';
    }
    const diff = p1.re - p2.re;   // 红笔 − 黑笔
    if (Math.abs(diff) < 0.5) return '0V';
    return (diff > 0 ? '+' : '') + Math.round(diff) + 'V';
  }
}

/**
 * 通用悬浮面板拖动（万用表/排故面板/3D 视窗共用）。
 * @param {HTMLElement} el 面板元素（须 position:fixed 且有 offsetLeft/offsetTop）
 * @param {string} ignoreSel 命中该选择器的目标不触发拖动（如按钮）
 * @returns {() => void} dispose 函数：摘除全部监听（悬浮窗反复开/关必须调用，否则 document 监听无限累积）
 */
export function makeDraggable(el, ignoreSel) {
  if (!el) return () => {};
  let d = false, sx, sy, ox, oy;
  const onMD = e => {
    if (ignoreSel && e.target.closest(ignoreSel)) return;
    d = true; sx = e.clientX; sy = e.clientY; ox = el.offsetLeft; oy = el.offsetTop; e.preventDefault();
  };
  const onMM = e => {
    if (!d) return;
    if (!(e.buttons & 1)) { d = false; return; }   // 窗口外释放鼠标（mouseup 丢失）→ 立即结束拖动，防"粘"指针
    el.style.left = (ox + e.clientX - sx) + 'px'; el.style.top = (oy + e.clientY - sy) + 'px'; el.style.right = 'auto';
  };
  const onMU = () => { d = false; };
  el.addEventListener('mousedown', onMD);
  document.addEventListener('mousemove', onMM);
  document.addEventListener('mouseup', onMU);
  return () => {
    el.removeEventListener('mousedown', onMD);
    document.removeEventListener('mousemove', onMM);
    document.removeEventListener('mouseup', onMU);
  };
}

export function initMeterPanelDrag() {
  makeDraggable(document.getElementById('meterPanel'), 'button, #meterDisplay');
}
