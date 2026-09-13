/**
 * 虚拟接线仿真系统 — 布尔表达式（when/bind 逻辑运算支持）
 *
 * 语法（完整布尔表达式，标准优先级）：
 *   expr    := or
 *   or      := and ( '||' and )*
 *   and     := not ( '&&' not )*
 *   not     := '!' not | primary
 *   primary := '(' expr ')' | IDENT
 *   IDENT   := [A-Za-z_][A-Za-z0-9_]*        （求值 = !!params[标识符]）
 *
 * 优先级：!（一元，最高）> && > ||；括号内先算。
 * 旧语法（单键 / "!键"，如 "energized" / "!energized"）是特例，天然兼容。
 *
 * compileExpr(src) → { keys: [全部标识符去重], fn: (params) => boolean }
 *   - keys 供 bindKeys 等提取"表达式引用了哪些状态键"（显示键写入联动）；
 *   - fn 为已编译闭包（每 tick 直接调用，微秒级；编译只发生一次，结果缓存）；
 *   - 编译失败 → console.error（指明表达式与原因）+ 恒 false 回退（配置写错不炸引擎）。
 */
export function compileExpr(src) {
  if (typeof src !== 'string' || !src.trim()) return { keys: [], fn: () => false };
  try {
    const tokens = tokenize(src);
    if (!tokens.length) return { keys: [], fn: () => false };
    let pos = 0;
    const keys = new Set();
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    function parseOr() {
      let left = parseAnd();
      while (peek() && peek().t === 'op' && peek().v === '||') {
        next();
        const l = left, r = parseAnd();
        left = p => l(p) || r(p);
      }
      return left;
    }
    function parseAnd() {
      let left = parseNot();
      while (peek() && peek().t === 'op' && peek().v === '&&') {
        next();
        const l = left, r = parseNot();
        left = p => l(p) && r(p);
      }
      return left;
    }
    function parseNot() {
      if (peek() && peek().t === 'op' && peek().v === '!') {
        next();
        const c = parseNot();
        return p => !c(p);
      }
      return parsePrimary();
    }
    function parsePrimary() {
      const tk = next();
      if (!tk) throw new Error('表达式意外结束');
      if (tk.t === 'lparen') {
        const e = parseOr();
        const cl = next();
        if (!cl || cl.t !== 'rparen') throw new Error('缺少右括号');
        return e;
      }
      if (tk.t === 'ident') {
        keys.add(tk.v);
        return p => !!p[tk.v];
      }
      throw new Error('意外的记号 "' + tk.v + '"');
    }

    const fn = parseOr();
    if (pos !== tokens.length) throw new Error('多余的记号 "' + tokens[pos].v + '"');
    return { keys: [...keys], fn };
  } catch (err) {
    console.error('[bool-expr] 表达式编译失败: "' + src + '" — ' + err.message + '（回退恒 false）');
    return { keys: [], fn: () => false };
  }
}

/** 词法分析：IDENT / ! / && / || / ( / ) / 空白 */
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '!') { out.push({ t: 'op', v: '!' }); i++; continue; }
    if (c === '(') { out.push({ t: 'lparen', v: '(' }); i++; continue; }
    if (c === ')') { out.push({ t: 'rparen', v: ')' }); i++; continue; }
    if (c === '&' && src[i + 1] === '&') { out.push({ t: 'op', v: '&&' }); i += 2; continue; }
    if (c === '|' && src[i + 1] === '|') { out.push({ t: 'op', v: '||' }); i += 2; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error('无法识别的字符 "' + c + '"');
  }
  return out;
}
