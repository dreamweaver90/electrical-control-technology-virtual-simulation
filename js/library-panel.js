/**
 * 虚拟接线仿真系统 — 元件库面板
 *
 * 右上角悬浮面板，两个 tab：
 *   独立元件  按分类分组，支持 HTML5 拖拽到配电盘；
 *   场景组合  配置文件定义的场景（多器件自动布局 + 预接线），拖拽到空白配电盘放置。
 */

export class LibraryPanel {
  /**
   * @param {HTMLElement} containerEl  独立元件容器 DOM
   * @param {ComponentDefinition[]} defs  元器件定义列表
   */
  constructor(containerEl, defs) {
    this.el    = containerEl;
    this.defs  = defs;
    this.cards = new Map();   // defId → DOM
  }

  /** 渲染元件库列表 */
  render() {
    this.el.innerHTML = '';

    // 按分类分组
    const groups = new Map();
    for (const d of this.defs) {
      const cat = d.categoryLabel;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(d);
    }

    for (const [cat, defs] of groups) {
      const sec = document.createElement('div');
      sec.className = 'lib-section';

      const title = document.createElement('div');
      title.className = 'lib-section-title';
      title.textContent = cat;
      sec.appendChild(title);

      // 同类器件横排（一行放不下自动换行）
      const cards = document.createElement('div');
      cards.className = 'lib-cards';
      for (const d of defs) {
        const card = this._createCard(d);
        cards.appendChild(card);
        this.cards.set(d.id, card);
      }
      sec.appendChild(cards);
      this.el.appendChild(sec);
    }
  }

  /**
   * 渲染场景组合列表（拖拽数据 = 'scene:<id>'，由 App._placeScene 处理）。
   * @param {HTMLElement} containerEl 场景容器 DOM（#libraryScenes）
   * @param {Array} scenes 场景配置数组（system_config_v3.json 顶层 scenes）
   */
  renderScenes(containerEl, scenes) {
    containerEl.innerHTML = '';
    if (!Array.isArray(scenes) || scenes.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#aaa;font-size:12px;text-align:center;padding:24px 0;';
      empty.textContent = '暂无场景组合（在 system_config_v3.json 的 scenes 数组中定义）';
      containerEl.appendChild(empty);
      return;
    }
    for (const [idx, scene] of scenes.entries()) {
      const card = document.createElement('div');
      card.className = 'lib-scene-card';
      card.draggable = true;
      card.title = scene.description || scene.name;
      card.dataset.sceneId = scene.id;

      const icon = document.createElement('div');
      icon.className = 'lib-scene-icon';
      icon.textContent = idx + 1;   // 大号数字序号（场景列表顺序）
      card.appendChild(icon);

      const info = document.createElement('div');
      const nm = document.createElement('div');
      nm.className = 'lib-scene-name';
      nm.textContent = scene.name || scene.id;
      info.appendChild(nm);
      const ds = document.createElement('div');
      ds.className = 'lib-scene-desc';
      const ws = scene.wires || [];
      const nE = ws.filter(w => (w.media || 'electrical') !== 'pneumatic').length;
      const nP = ws.length - nE;
      ds.textContent = (scene.description || '') + '（' + (scene.components || []).length + ' 器件 / ' + nE + ' 导线' + (nP ? ' / ' + nP + ' 气管' : '') + '）';
      info.appendChild(ds);
      card.appendChild(info);

      card.addEventListener('dragstart', e => {
        card.classList.add('dragging');
        e.dataTransfer.setData('text/plain', 'scene:' + scene.id);
        // ★ 必须与行拖放目标的 dropEffect 一致（panel-manager 设 'move'）：
        //   effectAllowed 不含 move 时 dragover 的 dropEffect='move' 会被规范强制置 'none'，
        //   导致有线槽模式 drop 事件不触发（无线槽 dragover 不设 dropEffect，不受影响）
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));

      containerEl.appendChild(card);
    }
  }

  _createCard(def) {
    const card = document.createElement('div');
    card.className = 'lib-card';
    card.draggable = true;
    card.dataset.defId = def.id;

    // 缩略图（v3：DOM 字符串渲染；优先 thumbnail 配置，缺省回退 image[0]）
    const thumb = document.createElement('div');
    thumb.className = 'lib-thumb';
    thumb.title = def.description || def.name;   // 悬停显示完整备注
    thumb.innerHTML = def.thumbString();
    // 无 viewBox 的 svg 不能等比缩放（内容按绝对坐标绘制，大图会被容器裁剪成空白）
    // → 自动从 width/height 属性注入 viewBox，配合 CSS 100% 等比居中显示
    const svg = thumb.querySelector('svg');
    if (svg && !svg.getAttribute('viewBox')) {
      const w = parseFloat(svg.getAttribute('width'));
      const h = parseFloat(svg.getAttribute('height'));
      if (w > 0 && h > 0) svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    }
    card.appendChild(thumb);

    // 名字（完整 description 由缩略图 title 悬停显示）
    const nm = document.createElement('div');
    nm.className = 'lib-name';
    nm.textContent = def.name;
    card.appendChild(nm);

    // 拖拽开始
    card.addEventListener('dragstart', e => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', def.id);
      e.dataTransfer.effectAllowed = 'move';

      const gh = thumb.cloneNode(true);
      gh.style.width = '60px'; gh.style.height = '60px';
      gh.style.position = 'absolute'; gh.style.top = '-9999px';
      document.body.appendChild(gh);
      e.dataTransfer.setDragImage(gh, 30, 30);
      setTimeout(() => gh.remove(), 0);
    });

    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    return card;
  }

  /** 更新单例器件的禁用状态 */
  updateSingleton(defId, placed) {
    const card = this.cards.get(defId);
    if (!card) return;
    if (placed) {
      card.classList.add('disabled');
      card.draggable = false;
    } else {
      card.classList.remove('disabled');
      card.draggable = true;
    }
  }
}
