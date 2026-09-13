/**
 * 虚拟接线仿真系统 — 稳态网络求解器（MNA 相量求解）
 *
 * 架构：双层网络模型
 *   结构层（buildGraph，并查集）   导线/闭合触点/恒连 = 0Ω 边
 *       → 岛划分、短路布尔判定、带电检测、电机接法/相序判定
 *   数值层（本模块，MNA 矩阵）    真实阻抗支路（线圈/绕组/热元件/断路器触头/电流表分流/电源内阻）
 *       → 节点电位（AC=50Hz 相量、DC=实数）与全部支路电流
 *
 * 求解流程（每 tick 一次，单次求解不迭代）：
 *   ① 收集数值支路：inst.numericBranches()（子类按自身状态返回 {a,b,z,key}）
 *   ② 数值图：buildGraph({ branchPairKeys }) —— 有数值支路的触点对不合并（保留为支路）
 *   ③ 源注册：working 电源输出端子 → EMF（AcPowerInstance.sourceEmf / RectifierInstance.sourceEmf）
 *      + 内阻 Zs 支路（金属性短路时由 Zs 限流，避免矩阵奇异）
 *   ④ 按结构层分量分岛求解：同域（全 AC 或全 DC）求解，混域岛跳过（结构层已判短路），无源岛跳过
 *   ⑤ 输出：节点电位 + 支路电流（一次求解全部支路电流，O(支路数)，与"端子对数"无关）
 */
import { G } from './globals.js';
import { buildGraph, pairKeyOf, UnionFind } from './graph.js';

/* ================================================================
   复数运算（模块内工具；AC 相量用，DC 岛复用同一套代码，im 恒 0）
   ================================================================ */
const cadd = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const csub = (a, b) => ({ re: a.re - b.re, im: a.im - b.im });
const cmul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cdiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
const cmag = a => Math.hypot(a.re, a.im);

/** 复数高斯消元（部分主元）。奇异返回 null。n 为矩阵规模（典型 < 100，稠密即可） */
function solveLinear(A, b) {
  const n = A.length;
  for (let col = 0; col < n; col++) {
    let piv = col, best = cmag(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const m = cmag(A[r][col]);
      if (m > best) { best = m; piv = r; }
    }
    if (best < 1e-12) return null;   // 主元退化 → 岛奇异（放弃求解，电位保持未定义）
    if (piv !== col) {
      const tA = A[col]; A[col] = A[piv]; A[piv] = tA;
      const tb = b[col]; b[col] = b[piv]; b[piv] = tb;
    }
    const d = A[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = cdiv(A[r][col], d);
      if (cmag(f) < 1e-15) continue;
      for (let c = col; c < n; c++) A[r][c] = csub(A[r][c], cmul(f, A[col][c]));
      b[r] = csub(b[r], cmul(f, b[col]));
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s = csub(s, cmul(A[r][c], x[c]));
    x[r] = cdiv(s, A[r][r]);
  }
  return x;
}

/** 求解单个岛（同域同岛）。结果写入 nodeVoltages / domains / sourceOwners / branchCurrents */
function solveIsland(isl, dom, numUF, nodeVoltages, domains, sourceOwners, branchCurrents) {
  const isDC = dom.startsWith('dc');
  const nodes = [...isl.nodes];
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const N = nodes.length + isl.srcs.length;
  if (N === 0) return;

  // 本岛源归属（电源实例 id 集合）：跨岛但同电源的两端（如三相电源的 L1 与 N）电位差有效
  const owners = new Set();
  for (const s of isl.srcs) owners.add(s.ps.instanceId);

  // 导纳矩阵（零初始化）
  const Y = Array.from({ length: N }, () => new Array(N).fill(null));
  const rhs = new Array(N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) Y[i][j] = { re: 0, im: 0 };
    rhs[i] = { re: 0, im: 0 };
  }

  // 支路 stamping
  for (const b of isl.branches) {
    const i = idx.get(b.n1), j = idx.get(b.n2);
    if (i === undefined || j === undefined) continue;
    // DC 稳态：电感感抗 = 0 → 用直流电阻（b.zdc 优先，缺省 = 运行阻抗实部），
    // 分压按直流电阻（交流线圈 R、电机绕组 dcResistance）；AC 岛保留完整相量阻抗（R + jX，50Hz）
    const z = isDC ? (b.zdc || { re: b.z.re, im: 0 }) : b.z;
    const y = cdiv({ re: 1, im: 0 }, z);
    Y[i][i] = cadd(Y[i][i], y); Y[j][j] = cadd(Y[j][j], y);
    Y[i][j] = csub(Y[i][j], y); Y[j][i] = csub(Y[j][i], y);
  }

  // 源：EMF 固定电位节点 + 内阻 Zs 支路
  isl.srcs.forEach((s, k) => {
    const e = nodes.length + k;                    // EMF 节点索引
    const i = idx.get(numUF.find(s.term));
    if (i === undefined) return;
    const y = cdiv({ re: 1, im: 0 }, { re: s.zs, im: 0 });
    Y[e][e] = cadd(Y[e][e], y); Y[i][i] = cadd(Y[i][i], y);
    Y[e][i] = csub(Y[e][i], y); Y[i][e] = csub(Y[i][e], y);
  });
  // 固定 EMF 节点：行替换为单位行
  isl.srcs.forEach((s, k) => {
    const e = nodes.length + k;
    for (let j = 0; j < N; j++) Y[e][j] = { re: 0, im: 0 };
    Y[e][e] = { re: 1, im: 0 };
    rhs[e] = s.emf;
  });

  const x = solveLinear(Y, rhs);
  if (!x) return;   // 岛奇异 → 全部保持未定义

  for (let i = 0; i < nodes.length; i++) {
    nodeVoltages.set(nodes[i], x[i]);
    domains.set(nodes[i], dom);
    sourceOwners.set(nodes[i], owners);
  }
  for (const b of isl.branches) {
    const vi = nodeVoltages.get(b.n1), vj = nodeVoltages.get(b.n2);
    if (vi && vj) {
      const z = isDC ? (b.zdc || { re: b.z.re, im: 0 }) : b.z;   // 与 stamping 同规则
      branchCurrents.set(b.key, cdiv(csub(vi, vj), z));
    }
  }
  // 源内阻支路电流：I = (EMF − V_term) / Zs（注入网络的电流）。
  // 供整流器/变压器功率反射折算（S = V·conj(I)）及电源输出电流测量使用。
  isl.srcs.forEach((s, k) => {
    const e = nodes.length + k;                  // EMF 节点索引（与 stamping 同规则）
    const i = idx.get(numUF.find(s.term));
    if (i === undefined) return;
    const ve = x[e], vt = x[i];
    if (ve && vt) {
      branchCurrents.set(s.ps.instanceId + '|src:' + s.term.id, cdiv(csub(ve, vt), { re: s.zs, im: 0 }));
    }
  });
}

/**
 * 求解整网。
 * @param {ComponentInstance[]} powerInsts 全部电源实例（engine 按 power 能力收集）
 * @returns {SolveResult}
 */
export function solveNetwork(powerInsts) {
  const nodeVoltages = new Map();      // 数值节点 root → 电位 {re, im}
  const domains = new Map();           // 数值节点 root → 岛标识 'ac#1'/'dc#2'
  const sourceOwners = new Map();      // 数值节点 root → Set(电源实例 id)（跨岛同电源测量有效）
  const branchCurrents = new Map();    // 支路 key → 电流 {re, im}

  // ① 收集数值支路（子类实现；无数值支路 = 纯 0Ω 导体，不算电流）
  const branches = [];
  for (const inst of G.panel.instances.values()) {
    for (const b of inst.numericBranches()) {
      if (b && b.a && b.b && b.z) {
        branches.push({ inst, a: b.a, b: b.b, z: b.z, zdc: b.zdc || null, key: b.key || pairKeyOf(b.a, b.b) });
      }
    }
  }

  // ② 数值图：有数值支路的端子对不合并（保留为支路）
  const branchPairKeys = new Set(branches.map(b => pairKeyOf(b.a, b.b)));
  const numUF = buildGraph({ branchPairKeys });

  // ③ 源：working 电源输出端子的 EMF + 内阻（Zs=0 缺省 0.5Ω，保证短路可解）
  const srcs = [];
  for (const ps of powerInsts) {
    if (!ps.working) continue;
    const zs = (ps.params && ps.params.sourceImpedance) || 0.5;
    const ac = !!(ps.definition.sourceDef && ps.definition.sourceDef.type === 'ac');
    for (const t of ps.outputTerminals()) {
      const emf = ps.sourceEmf ? ps.sourceEmf(t) : null;
      if (emf) srcs.push({ term: t, emf, zs, ac, ps });
    }
  }

  // ④ 按数值层连通性分岛：数值节点 + 支路端点并查集（支路是岛的"边"）。
  //    ⚠ 不能用结构层分量分岛：负载自由图里线圈/绕组不是边，星形电机等会让一个
  //    电路岛在结构层裂成多个分量（共享星点），必须按"含支路的数值连通性"分组。
  const islUF = new UnionFind();
  for (const b of branches) islUF.union(numUF.find(b.a), numUF.find(b.b));
  const islands = new Map();   // 数值岛 root → { nodes:Set, branches:[], srcs:[] }
  const getIsl = root => {
    let isl = islands.get(root);
    if (!isl) { isl = { nodes: new Set(), branches: [], srcs: [] }; islands.set(root, isl); }
    return isl;
  };
  for (const b of branches) {
    const isl = getIsl(islUF.find(numUF.find(b.a)));
    isl.nodes.add(numUF.find(b.a)); isl.nodes.add(numUF.find(b.b));
    isl.branches.push({ n1: numUF.find(b.a), n2: numUF.find(b.b), z: b.z, zdc: b.zdc || null, key: b.inst.instanceId + '|' + b.key });
  }
  for (const s of srcs) {
    const isl = getIsl(islUF.find(numUF.find(s.term)));
    isl.nodes.add(numUF.find(s.term));
    isl.srcs.push(s);
  }

  // ⑤ 逐岛求解：无源岛跳过（全部未定义）；混域岛跳过（结构层已判短路，不做混合求解）
  // 域 = 岛唯一标识（'ac#1'/'dc#2'…）：不同岛之间电位差无定义（如两个独立整流器输出之间），
  // 电压测量/线圈判定必须同岛才有效（voltageBetween 检查 d1===d2）
  let islandSeq = 0;
  for (const isl of islands.values()) {
    if (isl.srcs.length === 0) continue;
    const hasAC = isl.srcs.some(s => s.ac);
    const hasDC = isl.srcs.some(s => !s.ac);
    if (hasAC && hasDC) continue;
    const dom = (hasAC ? 'ac' : 'dc') + '#' + (++islandSeq);
    solveIsland(isl, dom, numUF, nodeVoltages, domains, sourceOwners, branchCurrents);
  }

  return new SolveResult(numUF, nodeVoltages, domains, sourceOwners, branchCurrents);
}

/** 求解结果（消费方：线圈/整流器/电机/热继电器/电表/万用表） */
export class SolveResult {
  constructor(numUF, nodeVoltages, domains, sourceOwners, branchCurrents) {
    this.numUF = numUF;
    this.nodeVoltages = nodeVoltages;
    this.domains = domains;
    this.sourceOwners = sourceOwners;
    this.branchCurrents = branchCurrents;
  }

  /** 端子电位相量 {re,im}；未定义（无源岛/混域/悬空）返回 null */
  potential(term) {
    if (!term) return null;
    return this.nodeVoltages.get(this.numUF.find(term)) || null;
  }

  /** 端子所在岛域（岛唯一标识）：'ac#1' / 'dc#2' / null；判断交流/直流用 startsWith */
  domainOf(term) {
    if (!term) return null;
    return this.domains.get(this.numUF.find(term)) || null;
  }

  /**
   * 两端是否属于同一电位参考系：同岛，或跨岛但同属一个电源实例
   * （如三相电源的 L1 与 N 是独立数值岛，但同电源定义 → 测量 220V 有效）。
   */
  sameReference(t1, t2) {
    const d1 = this.domainOf(t1), d2 = this.domainOf(t2);
    if (!d1 || !d2) return false;
    if (d1 === d2) return true;
    const o1 = this.sourceOwners.get(this.numUF.find(t1));
    const o2 = this.sourceOwners.get(this.numUF.find(t2));
    if (!o1 || !o2) return false;
    for (const id of o1) if (o2.has(id)) return true;
    return false;
  }

  /** 支路电流相量：currentOf(inst, key)（key = numericBranches 返回的 key，如 'load:coil1'） */
  currentOf(inst, key) {
    return this.branchCurrents.get(inst.instanceId + '|' + key) || null;
  }

  /** 源内阻支路电流（power 器件输出端子注入网络的电流）：sourceCurrent(inst, term)；未解出/无源 → null */
  sourceCurrent(inst, term) {
    return this.branchCurrents.get(inst.instanceId + '|src:' + term.id) || null;
  }

  /** 两点电压幅值（相量差模长）：voltageBetween(t1, t2)；任一端未定义/不同参考系 → null */
  voltageBetween(t1, t2) {
    const p1 = this.potential(t1), p2 = this.potential(t2);
    if (!p1 || !p2) return null;
    if (!this.sameReference(t1, t2)) return null;   // 不同电位参考系 → 电位差无定义
    return Math.hypot(p1.re - p2.re, p1.im - p2.im);
  }
}
