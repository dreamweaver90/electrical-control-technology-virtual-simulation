/**
 * 虚拟接线仿真系统 — 十字工作台 3D 视图（table3d.js）
 *
 * 从《十字滑台.html》（Three.js r160 独立演示）重构的纯展示模块，供
 * SlideTableInstance 的悬浮 3D 视窗使用：
 *   - 外部负责：加载 js/three.global.js（window.THREE）、提供 canvas 元素、
 *     setState(x01, y01, rpmX, rpmY) 注入数据（每仿真 tick 调用）；
 *   - 本类负责：场景构建（底座/导轨/丝杠/双电机/双层滑台/工件）、轨道相机交互
 *     （左键旋转 · 滚轮缩放）、rAF 渲染循环、丝杠旋转动画、位置平滑过渡。
 *
 * 坐标系（与演示一致）：机器 X 轴 → world X（右），机器 Y 轴 → world Z（进深）；
 * 位置 0~1（0=负端 0.5=中点 1=正端）换算 ±60mm 行程；rpm 带符号（正 = 正向）。
 * 生命周期：new → resize() → start()；dispose() 释放（WebGL 上下文/监听/rAF）。
 * window.THREE 缺失时构造抛错（调用方惰性加载 three 后再 new）。
 */
export class Table3DView {
  constructor(canvas) {
    const T = window.THREE;
    if (!T) throw new Error('Three.js 未加载（需要 js/three.global.js）');
    this._T = T;
    this._canvas = canvas;

    // ---- 渲染器 ----
    const renderer = new T.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = T.SRGBColorSpace;
    this._renderer = renderer;

    // ---- 场景 / 相机（默认视角针对悬浮窗小画布拉近：radius 290 ≈ 底座 210 占画面 ~85%）----
    this._scene = new T.Scene();
    this._scene.background = new T.Color(0x26303c);
    this._scene.fog = new T.Fog(0x26303c, 600, 1600);
    this._camera = new T.PerspectiveCamera(45, 1, 0.1, 2000);
    this._orbit = { radius: 290, theta: 0, phi: 0.32, target: new T.Vector3(0, 26, 0) };

    // ---- 运行状态（setState 注入）----
    this._x01 = 0.5; this._y01 = 0.5;   // 目标位置（0~1）
    this._cx = 0; this._cy = 0;         // 平滑后的显示位置（mm，初始 0 = 中点）
    this._rpmX = 0; this._rpmY = 0;     // 目标转速
    this._spinX = 0; this._spinY = 0;   // 丝杠累计转角（rad）
    this._raf = 0; this._last = 0;
    this._onMD = null; this._onMW = null;

    this._buildScene();
    this._bindOrbit();
  }

  /** 注入仿真状态：x01/y01 ∈ [0,1]，rpm 带符号（每 tick 调一次） */
  setState(x01, y01, rpmX, rpmY) {
    this._x01 = x01; this._y01 = y01;
    this._rpmX = rpmX; this._rpmY = rpmY;
  }

  /** 画布尺寸自适应（窗固定大小时调用一次即可） */
  resize() {
    const r = this._canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  start() {
    if (this._raf) return;
    this._last = performance.now();
    const loop = now => {
      this._raf = requestAnimationFrame(loop);
      this._frame((now - this._last) / 1000);
      this._last = now;
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
  }

  /** 销毁：停渲染、释放 WebGL 上下文与监听（重开时 new 新实例） */
  dispose() {
    this.stop();
    const c = this._canvas;
    if (this._onMD) { c.removeEventListener('mousedown', this._onMD); this._onMD = null; }
    if (this._onMW) { c.removeEventListener('wheel', this._onMW); this._onMW = null; }
    if (window._table3dUp) { window.removeEventListener('mouseup', window._table3dUp); window._table3dUp = null; }
    if (window._table3dMM) { window.removeEventListener('mousemove', window._table3dMM); window._table3dMM = null; }
    this._renderer.dispose();
    if (this._renderer.forceContextLoss) this._renderer.forceContextLoss();
  }

  /* ============ 内部：场景构建（模型结构照搬《十字滑台.html》） ============ */
  _buildScene() {
    const T = this._T, scene = this._scene;
    // 灯光（同演示）
    scene.add(new T.HemisphereLight(0xeaf1ff, 0x4a5560, 1.65));
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    const sun = new T.DirectionalLight(0xffffff, 1.6);
    sun.position.set(120, 190, 90); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const ds = 200;
    sun.shadow.camera.left = -ds; sun.shadow.camera.right = ds;
    sun.shadow.camera.top = ds; sun.shadow.camera.bottom = -ds;
    sun.shadow.camera.near = 10; sun.shadow.camera.far = 600;
    scene.add(sun);
    const fill = new T.DirectionalLight(0xaecbff, 0.6);
    fill.position.set(-120, 80, -100);
    scene.add(fill);

    // 材质（同演示）
    const mat = {
      base:     this._mat(0x55606b, 0.5, 0.5),
      rail:     this._mat(0xb4bdc5, 0.85, 0.3),
      railFill: this._mat(0xdfe3d7, 0.7, 0.32),
      plate:    this._mat(0x47525c, 0.5, 0.5),
      platform: this._mat(0x3f4a55, 0.45, 0.55),
      motor:    this._mat(0x3d4650, 0.4, 0.6),
      flange:   this._mat(0xccd2d8, 0.9, 0.28),
      screw:    this._mat(0xdbdfe3, 1.0, 0.22),
      stripe:   this._mat(0x6b737e, 0.3, 0.7),
      redTag:   this._mat(0xcf5656, 0.15, 0.6, 0x3a0202, 0.5),
      work:     this._mat(0x5a92e8, 0.15, 0.45),
    };
    const box = (w, h, d, m) => { const x = new T.Mesh(new T.BoxGeometry(w, h, d), m); x.castShadow = true; x.receiveShadow = true; return x; };
    const cyl = (rt, rb, h, seg, m) => { const x = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg), m); x.castShadow = true; x.receiveShadow = true; return x; };

    // ---- 底座 ----
    const base = new T.Group();
    const basePlate = box(210, 6, 210, mat.base); basePlate.position.y = 3; base.add(basePlate);

    // Y 导轨（沿 world Z，固定底座）
    const makeZRail = x => {
      const g = new T.Group();
      const body = box(9, 9, 200, mat.rail); body.position.y = 13; g.add(body);
      const top = box(4, 1.2, 200, mat.railFill); top.position.set(0, 18.1, 0); g.add(top);
      [[-96], [96]].forEach(([z]) => { const blk = box(9, 2.6, 9, mat.base); blk.position.set(0, 8, z); g.add(blk); });
      g.position.x = x; base.add(g);
    };
    makeZRail(-32); makeZRail(32);

    // Y 丝杠 + Y 电机（后端）+ 联轴器/支撑
    const yScrew = this._makeScrew(200, 3.0, mat);
    yScrew.holder.position.set(0, 11, 0); base.add(yScrew.holder);
    this._orient(yScrew.holder, 'z');
    const motorY = this._makeMotor(mat);
    motorY.group.position.set(0, 11, 104);
    base.add(motorY.group);
    const couplerY = cyl(2.0, 2.0, 9, 14, mat.flange); couplerY.rotation.x = Math.PI / 2; couplerY.position.set(0, 11, 100.5); base.add(couplerY);
    const mntY = box(16, 18, 8, mat.base); mntY.position.set(0, 8, 104); base.add(mntY);
    const supZ = box(12, 12, 8, mat.base); supZ.position.set(0, 11, -103.5); base.add(supZ);

    // ---- Y 滑台（长横梁，沿 world Z，随丝杠螺母）----
    const yCarriage = new T.Group();
    const yPlate = box(200, 7, 42, mat.plate); yPlate.position.y = 21; yCarriage.add(yPlate);
    const yNut = box(14, 10, 14, mat.flange); yNut.position.set(0, 12.75, 0); yCarriage.add(yNut);

    const makeXRail = z => {
      const g = new T.Group();
      const body = box(200, 9, 9, mat.rail); body.position.y = 29; g.add(body);
      const top = box(200, 1.2, 4, mat.railFill); top.position.y = 34.1; g.add(top);
      g.position.z = z; yCarriage.add(g);
    };
    makeXRail(-15); makeXRail(15);

    // X 丝杠 + X 电机（右端）+ 联轴器/支撑（随 Y 滑台）
    const xScrew = this._makeScrew(200, 3.0, mat);
    xScrew.holder.position.set(0, 27, 0); yCarriage.add(xScrew.holder);
    this._orient(xScrew.holder, 'x');
    const motorX = this._makeMotor(mat);
    motorX.group.position.set(104, 27, 0); motorX.group.rotation.set(0, Math.PI / 2, 0);
    yCarriage.add(motorX.group);
    const couplerX = cyl(2.0, 2.0, 9, 14, mat.flange); couplerX.rotation.z = Math.PI / 2; couplerX.position.set(100.5, 27, 0); yCarriage.add(couplerX);
    const mntX = box(8, 18, 14, mat.base); mntX.position.set(104, 22, 0); yCarriage.add(mntX);
    const supX = box(8, 12, 12, mat.base); supX.position.set(-103.5, 27, 0); yCarriage.add(supX);

    base.add(yCarriage);

    // ---- X 滑台（台面，沿 world X，挂在 Y 滑台内）----
    const xCarriage = new T.Group();
    const topPlate = box(72, 7, 62, mat.platform); topPlate.position.y = 37; xCarriage.add(topPlate);
    [[-30, -26], [-30, 26], [30, -26], [30, 26], [0, 0]].forEach(([hx, hz]) => {
      const b = new T.Mesh(new T.CylinderGeometry(1.8, 1.8, 7.2, 18), mat.base);
      b.rotation.x = Math.PI / 2; b.position.set(hx, 37, hz); xCarriage.add(b);
    });
    [[0, 30.5, 72, 3], [0, -30.5, 72, 3], [34.5, 0, 3, 62], [-34.5, 0, 3, 62]].forEach(([px, pz, lx, lz]) => {
      const e = box(lx, 1.6, lz, mat.railFill); e.position.set(px, 41, pz); xCarriage.add(e);
    });
    const xNut = box(14, 10, 14, mat.flange); xNut.position.set(0, 28.5, 0); xCarriage.add(xNut);
    const workpiece = box(24, 12, 24, mat.work); workpiece.position.y = 46.5; xCarriage.add(workpiece);
    yCarriage.add(xCarriage);

    // ---- 地面 + 网格 ----
    const ground = new T.Mesh(new T.CircleGeometry(560, 48), new T.MeshStandardMaterial({ color: 0x202a34, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; ground.receiveShadow = true;
    scene.add(ground);
    const grid = new T.GridHelper(600, 30, 0x4c5a64, 0x35414b); grid.position.y = 0.02;
    scene.add(grid);

    // ---- 坐标系标记（红 X / 绿 Y，底座前左角；箭头末端带 X/Y 文字标签）----
    const axisArrow = (color, len) => {
      const g = new T.Group();
      const m = new T.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.4, emissive: color, emissiveIntensity: 0.25 });
      const shaft = new T.Mesh(new T.CylinderGeometry(1.0, 1.0, len - 7, 10), m);
      shaft.rotation.x = Math.PI / 2; shaft.position.z = (len - 7) / 2;
      const cone = new T.Mesh(new T.ConeGeometry(2.6, 7, 14), m);
      cone.rotation.x = Math.PI / 2; cone.position.z = len - 3;
      g.add(shaft); g.add(cone);
      return g;
    };
    const axisLabel = (text, color, pos) => {
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      const g = cv.getContext('2d');
      g.fillStyle = color; g.font = 'bold 44px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, 32, 34);
      const spr = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(cv), transparent: true }));
      spr.position.copy(pos); spr.scale.set(12, 12, 1);
      return spr;
    };
    const marker = new T.Group();
    marker.position.set(-96, 8.5, -96);
    const axX = axisArrow(0xf2363c, 32); axX.rotation.y = Math.PI / 2;
    const axY = axisArrow(0x33c15b, 32);
    marker.add(axX); marker.add(axY);
    marker.add(axisLabel('X', '#f2363c', new T.Vector3(44, 0, 0)));    // 箭头末端文字
    marker.add(axisLabel('Y', '#33c15b', new T.Vector3(0, 0, 44)));
    scene.add(marker);

    this._parts = { xCarriage, yCarriage, rotorX: xScrew.rotor, rotorY: yScrew.rotor };
    scene.add(base);
    this._applyCamera();
  }

  _mat(color, metalness, roughness, emissive, emissiveIntensity) {
    return new this._T.MeshStandardMaterial(
      emissive ? { color, metalness, roughness, emissive, emissiveIntensity } : { color, metalness, roughness });
  }

  /** 丝杠（含旋转体 rotor，供旋转动画） */
  _makeScrew(length, radius, mat) {
    const T = this._T;
    const holder = new T.Group();
    const rotor = new T.Group();
    const shaft = new T.Mesh(new T.CylinderGeometry(radius, radius, length, 24), mat.screw);
    const stripe = new T.Mesh(new T.BoxGeometry(radius * 0.5, length * 0.96, radius * 0.5), mat.stripe);
    stripe.position.set(-radius * 0.92, 0, 0);
    rotor.add(shaft); rotor.add(stripe);
    holder.add(rotor);
    return { holder, rotor };
  }

  _orient(holder, axis) {
    const T = this._T;
    const q = new T.Quaternion();
    if (axis === 'z') q.setFromUnitVectors(new T.Vector3(0, 1, 0), new T.Vector3(0, 0, 1));
    else if (axis === 'x') q.setFromUnitVectors(new T.Vector3(0, 1, 0), new T.Vector3(1, 0, 0));
    holder.quaternion.copy(q);
  }

  /** 电机小模型 */
  _makeMotor(mat) {
    const T = this._T;
    const g = new T.Group();
    const body = new T.Mesh(new T.CylinderGeometry(8, 8, 26, 22), mat.motor);
    body.rotation.x = Math.PI / 2; body.position.z = 10; g.add(body);
    const flange = new T.Mesh(new T.CylinderGeometry(9.2, 9.2, 2.4, 22), mat.flange);
    flange.rotation.x = Math.PI / 2; flange.position.z = -3; g.add(flange);
    const rear = new T.Mesh(new T.BoxGeometry(12, 12, 2), mat.motor); rear.position.z = 23; g.add(rear);
    const tag = new T.Mesh(new T.CylinderGeometry(6, 6, 0.6, 22), mat.redTag);
    tag.rotation.x = Math.PI / 2; tag.position.z = -4.2; g.add(tag);
    const cap = new T.Mesh(new T.CylinderGeometry(3.4, 3.4, 2.4, 18), mat.motor);
    cap.rotation.x = Math.PI / 2; cap.position.z = 26; g.add(cap);
    return { group: g };
  }

  /* ============ 内部：轨道相机 ============ */
  _applyCamera() {
    const o = this._orbit;
    const sinPhi = Math.sin(o.phi), cosPhi = Math.cos(o.phi);
    this._camera.position.set(
      o.target.x + o.radius * sinPhi * Math.sin(o.theta),
      o.target.y + o.radius * cosPhi,
      o.target.z + o.radius * sinPhi * Math.cos(o.theta));
    this._camera.lookAt(o.target);
  }

  _bindOrbit() {
    const c = this._canvas;
    let dragging = false, lastX = 0, lastY = 0;
    c.addEventListener('mousedown', this._onMD = e => { dragging = true; lastX = e.clientX; lastY = e.clientY; e.preventDefault(); });
    const onUp = () => { dragging = false; };
    const onMove = e => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this._orbit.theta -= dx * 0.006;
      this._orbit.phi -= dy * 0.006;
      if (this._orbit.phi < 0.15) this._orbit.phi = 0.15;
      if (this._orbit.phi > 1.45) this._orbit.phi = 1.45;
    };
    window._table3dUp = onUp; window._table3dMM = onMove;   // 单实例（工作台 singleton），模块级注册安全
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    c.addEventListener('wheel', this._onMW = e => {
      e.preventDefault();
      this._orbit.radius *= (1 + e.deltaY * 0.0012);
      if (this._orbit.radius < 120) this._orbit.radius = 120;
      if (this._orbit.radius > 520) this._orbit.radius = 520;
    }, { passive: false });
  }

  /* ============ 内部：渲染帧 ============ */
  _frame(dt) {
    const p = this._parts;
    // 位置平滑（仿真 50ms tick → 60fps 平滑过渡；系数 ~25/s）
    const k = 1 - Math.exp(-dt * 25);
    const targetX = (this._x01 - 0.5) * 120;   // 0~1 → ±60mm
    const targetY = (this._y01 - 0.5) * 120;
    this._cx += (targetX - this._cx) * k;
    this._cy += (targetY - this._cy) * k;
    p.xCarriage.position.x = this._cx;
    p.yCarriage.position.z = this._cy;

    // 丝杠旋转（rpm → rad/s ×0.9 视觉缩放，同演示）
    this._spinX += (this._rpmX / 60) * Math.PI * 2 * 0.9 * dt;
    this._spinY += (this._rpmY / 60) * Math.PI * 2 * 0.9 * dt;
    p.rotorX.rotation.y = this._spinX;
    p.rotorY.rotation.y = this._spinY;

    this._applyCamera();
    this._renderer.render(this._scene, this._camera);
  }
}
