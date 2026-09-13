/**
 * 虚拟接线仿真系统 — 参数设置面板
 *
 * 右键器件 → "参数设置" 打开。按配置 params 定义动态渲染表单：
 *   number         数值输入（min/max/step/unit）
 *   select         下拉选择（options: [{value, label}]）
 *   bool           开关（checkbox）
 *   text           文本输入（如按钮名称；可配合 display 配置在器件图上叠加显示）
 *   bind           绑定其他已实例化器件（allow 能力名列表限制可绑定的目标，按 hasCapability 匹配）
 *                  绑定模式下点选面板上的器件，存 instanceId 字符串）
 *
 * 确定时写回 inst.params 并 refreshDisplay；绑定目标被删除时由
 * panel-manager.removeInstance 清理引用。
 */

import { G } from './globals.js';

export class ParamPanel {
  static _active = null;   // 全局单例：同一时间只能有一个参数面板

  /** 打开参数面板（已有面板先关闭，全局唯一） */
  static open(inst, x, y) {
    if (ParamPanel._active) ParamPanel._active.destroy();
    ParamPanel._active = new ParamPanel(inst, x, y);
  }

  constructor(inst, x, y) {
    this.inst = inst;
    this.values = { ...inst.params };   // 编辑副本：确定才写回
    this._el = null;
    this._bindMode = null;              // 当前进入绑定模式的参数定义
    this._build(x, y);
  }

  destroy() {
    if (this._bindMode) this._exitBindMode();
    if (this._el) this._el.remove();
    this._el = null;
    if (ParamPanel._active === this) ParamPanel._active = null;
  }

  _build(x, y) {
    const def = this.inst.definition;
    const panel = document.createElement('div');
    panel.className = 'param-panel';
    panel.style.cssText =
      'position:fixed;z-index:150;width:280px;background:#fff;' +
      'border:1px solid #ccc;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.2);padding:14px;font-size:13px;';
    this._el = panel;

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;font-size:14px;margin-bottom:10px;';
    title.textContent = '⚙ ' + def.name + ' — 参数设置';
    panel.appendChild(title);

    // 渲染面板可见参数：adjustable（可编辑）与 readonly（只读显示，值由器件类钩子写入 params）
    for (const p of def.panelParams()) {
      panel.appendChild(this._renderField(p));
    }

    // 按钮行
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;margin-top:12px;';
    const ok = document.createElement('button');
    ok.textContent = '确定';
    ok.style.cssText = 'flex:1;padding:6px;border:none;border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer;';
    ok.addEventListener('click', () => this.save());
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText = 'flex:1;padding:6px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;';
    cancel.addEventListener('click', () => this.destroy());
    btns.appendChild(ok);
    btns.appendChild(cancel);
    panel.appendChild(btns);

    // 绑定模式提示条
    const hint = document.createElement('div');
    hint.className = 'param-bind-hint';
    hint.style.cssText = 'display:none;margin-top:8px;padding:6px;border-radius:6px;background:#fff8e1;color:#8a6d00;';
    hint.textContent = '绑定模式：请点选面板上的目标器件（ESC 取消）';
    panel.appendChild(hint);

    document.body.appendChild(panel);
    // 定位在鼠标附近（append 后测量尺寸，clamp 防止超出视口）
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const px = Math.max(8, Math.min((x !== undefined ? x : window.innerWidth - w - 24) - 8, window.innerWidth - w - 8));
    const py = Math.max(8, Math.min((y !== undefined ? y : 70) - 8, window.innerHeight - h - 8));
    panel.style.left = px + 'px';
    panel.style.top = py + 'px';
  }

  _renderField(p) {
    // readonly：只读显示行（计算值/铭牌派生值，值由类钩子写入 params，不渲染输入控件）
    if (p.readonly) return this._renderReadonly(p);
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:10px;';
    const label = document.createElement('div');
    label.style.cssText = 'margin-bottom:3px;color:#555;';
    label.textContent = p.label || p.id;
    row.appendChild(label);

    if (p.type === 'number') {
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const input = document.createElement('input');
      input.type = 'number';
      input.style.cssText = 'flex:1;padding:4px 6px;border:1px solid #ccc;border-radius:6px;';
      input.value = this.values[p.id] ?? p.default ?? '';
      if (p.min !== undefined) input.min = p.min;
      if (p.max !== undefined) input.max = p.max;
      if (p.step !== undefined) input.step = p.step;
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        this.values[p.id] = Number.isNaN(v) ? null : v;
      });
      box.appendChild(input);
      if (p.unit) {
        const u = document.createElement('span');
        u.textContent = p.unit;
        u.style.color = '#888';
        box.appendChild(u);
      }
      row.appendChild(box);
    } else if (p.type === 'select') {
      const sel = document.createElement('select');
      sel.style.cssText = 'width:100%;padding:4px 6px;border:1px solid #ccc;border-radius:6px;';
      const fill = () => {
        sel.innerHTML = '';
        const opts = this._resolveOptions(p);
        for (const opt of opts) {
          const o = document.createElement('option');
          o.value = String(opt.value);
          o.textContent = opt.label !== undefined ? String(opt.label) : String(opt.value);
          if (String(opt.value) === String(this.values[p.id] ?? '')) o.selected = true;
          sel.appendChild(o);
        }
        sel.disabled = !opts.length;
      };
      fill();
      // 动态 options（如 "bound:target.relativePositions"）：绑定变化时由 _refreshDynSelects 重拉
      if (typeof p.options === 'string') {
        this._dynSelects = this._dynSelects || [];
        this._dynSelects.push({ fill });
      }
      sel.addEventListener('change', () => {
        // sel.value 恒为字符串：按 option 原类型还原（如 unit 数字索引不被字符串化，保持类型契约）
        const m = this._resolveOptions(p).find(o => String(o.value) === sel.value);
        this.values[p.id] = m ? m.value : sel.value;
      });
      row.appendChild(sel);
    } else if (p.type === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!this.values[p.id];
      cb.style.cssText = 'width:18px;height:18px;cursor:pointer;';
      cb.addEventListener('change', () => { this.values[p.id] = cb.checked; });
      row.appendChild(cb);
    } else if (p.type === 'text') {
      const input = document.createElement('input');
      input.type = 'text';
      input.style.cssText = 'width:100%;padding:4px 6px;border:1px solid #ccc;border-radius:6px;';
      input.value = this.values[p.id] ?? p.default ?? '';
      input.addEventListener('input', () => { this.values[p.id] = input.value; });
      row.appendChild(input);
    } else if (p.type === 'bind') {
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;gap:6px;align-items:center;';
      const status = document.createElement('span');
      status.style.cssText = 'flex:1;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      this._updateBindStatus(status, p);
      const btn = document.createElement('button');
      btn.textContent = '绑定';
      btn.style.cssText = 'padding:4px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;';
      btn.addEventListener('click', () => this._enterBindMode(p, status, btn));
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = '删除绑定';
      del.style.cssText = 'padding:4px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;';
      del.addEventListener('click', () => { this.values[p.id] = null; this._updateBindStatus(status, p); this._refreshDynSelects(); });
      box.appendChild(status);
      box.appendChild(btn);
      box.appendChild(del);
      row.appendChild(box);
    }
    return row;
  }

  /** 只读显示行：label + 值文本（灰底禁改样式；空值 → —）。save() 只回写 adjustableParams，readonly 天然不写回 */
  _renderReadonly(p) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:10px;';
    const label = document.createElement('div');
    label.style.cssText = 'margin-bottom:3px;color:#555;';
    label.textContent = p.label || p.id;
    row.appendChild(label);
    const val = document.createElement('div');
    val.style.cssText = 'padding:5px 8px;background:#f4f6f8;border:1px solid #e2e6ea;border-radius:6px;' +
      'color:#333;font-variant-numeric:tabular-nums;min-height:18px;';
    const v = this.inst.params[p.id];
    val.textContent = this._fmtReadonly(p, v);
    row.appendChild(val);
    return row;
  }

  /** 只读值格式化（null/undefined → —；number → decimals；select → 选项 label；bool → 是/否；bind → 绑定目标名） */
  _fmtReadonly(p, v) {
    if (v === null || v === undefined || v === '') return '—';
    if (p.type === 'number') {
      const dec = p.decimals !== undefined ? p.decimals : ((p.display && p.display.decimals) !== undefined ? p.display.decimals : 2);
      return Number(v).toFixed(dec) + (p.unit ? ' ' + p.unit : '');
    }
    if (p.type === 'select') {
      const m = (Array.isArray(p.options) ? p.options : []).find(o => String(o.value) === String(v));
      return (m && m.label !== undefined) ? String(m.label) : String(v);
    }
    if (p.type === 'bool') return v ? '是' : '否';
    if (p.type === 'bind') {
      const t = v ? G.panel.instances.get(v) : null;
      return t ? '已绑定: ' + t.displayName() : '未绑定';
    }
    return String(v);
  }

  _updateBindStatus(statusEl, p) {
    const iid = this.values[p.id];
    if (iid) {
      const target = G.panel.instances.get(iid);
      statusEl.textContent = target ? '已绑定: ' + target.displayName() : '已失效(目标已删除)';
    } else {
      statusEl.textContent = '未绑定';
    }
  }

  /**
   * select 的 options 解析：
   *   数组 → 直接使用；
   *   字符串 "bound:<bind参数id>.<方法名>" → 从绑定实例调方法动态生成
   *   （如磁性传感器 unit：绑定气缸后下拉显示各单元 label，value = 单元索引）。
   */
  _resolveOptions(p) {
    if (typeof p.options === 'string' && p.options.startsWith('bound:')) {
      const [bindId, ...rest] = p.options.slice(6).split('.');
      const method = rest.join('.');
      const iid = this.values[bindId];
      const target = iid ? G.panel.instances.get(iid) : null;
      if (target && typeof target[method] === 'function') {
        return target[method]().map((u, i) => ({ value: i, label: u.label !== undefined ? u.label : u.posKey }));
      }
      return [];   // 未绑定/目标已失效/方法缺失 → 空 options（下拉禁用）
    }
    return p.options || [];
  }

  /** 动态 select 重拉 options（绑定目标变化后调用，保持当前选中值） */
  _refreshDynSelects() {
    if (this._dynSelects) for (const d of this._dynSelects) d.fill();
  }

  /* ---- 绑定模式 ---- */

  _enterBindMode(p, statusEl, btn) {
    if (this._bindMode) this._exitBindMode();
    this._bindMode = p;
    btn.textContent = '取消';
    const hint = this._el.querySelector('.param-bind-hint');
    if (hint) hint.style.display = 'block';
    // 绑定模式：全局 click（capture）点选面板上的器件卡片
    this._onBindClick = e => {
      const card = e.target.closest('.component-card');
      if (!card) return;
      const inst = G.panel.instances.get(card.dataset.instanceId);
      if (!inst || inst === this.inst) return;   // 不能绑自己
      // 能力匹配（蓝图 §5）：allow = 能力名列表，目标须具备全部所声明能力
      const allow = p.allow || [];
      if (allow.length && !allow.every(name => inst.hasCapability && inst.hasCapability(name))) {
        if (G.app) G.app.showToast('只能绑定具备能力: ' + allow.join(' / '), 'warn');
        return;
      }
      this.values[p.id] = inst.instanceId;
      this._updateBindStatus(statusEl, p);
      this._exitBindMode();
      this._refreshDynSelects();   // 动态下拉（如传感器 unit）随绑定目标刷新
      if (G.app) G.app.showToast('已绑定: ' + inst.displayName(), 'info');
    };
    this._onBindKey = e => { if (e.key === 'Escape') this._exitBindMode(); };
    document.addEventListener('click', this._onBindClick, true);
    document.addEventListener('keydown', this._onBindKey);
  }

  _exitBindMode() {
    if (!this._bindMode) return;
    this._bindMode = null;
    document.removeEventListener('click', this._onBindClick, true);
    document.removeEventListener('keydown', this._onBindKey);
    const hint = this._el.querySelector('.param-bind-hint');
    if (hint) hint.style.display = 'none';
    // 恢复按钮文案（只改第一个"取消"= 绑定按钮；底部取消按钮保持"取消"，勿误改）
    const btns = this._el.querySelectorAll('button');
    for (const b of btns) if (b.textContent === '取消') { b.textContent = '绑定'; break; }
  }

  /** 确定：写回 inst.params → 子类参数更新回调 → 刷新显示 → 关闭 */
  save() {
    // ★ number 参数统一按配置 min/max 钳制（input[type=number] 的 min/max 只约束步进/校验标记，
    //   手动输入超范围值不会被浏览器阻止——保存时钳制保证参数永远落在合法区间）
    for (const p of this.inst.definition.adjustableParams()) {
      if (p.type !== 'number') continue;
      let v = this.values[p.id];
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (p.min !== undefined && v < p.min) v = p.min;
        if (p.max !== undefined && v > p.max) v = p.max;
        if (v !== this.values[p.id]) this.values[p.id] = v;
      }
    }
    // ★ 只回写面板渲染过的可调字段。this.values 是打开时刻的全量副本——整体赋值会把
    //   面板打开期间引擎 scan 写入的运行键（tripped/阀位记忆 posKey/speed 等）覆盖成过期值
    //   （多数下一 tick 自愈，但 tripped 需手动复位、双线圈阀位置记忆不可自愈）。保持
    //   inst.params 原对象引用不变，逐字段写回。
    for (const p of this.inst.definition.adjustableParams()) {
      this.inst.params[p.id] = this.values[p.id];
    }
    this.inst.onParamsChanged();
    this.inst.refreshDisplay();
    this.destroy();
  }
}
