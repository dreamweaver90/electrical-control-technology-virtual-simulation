/**
 * 虚拟接线仿真系统 — 撤回/重做（undo.js）
 *
 * 快照式撤回：每次"结构编辑操作"（接线/删线/线标/器件放置删除拖动/清除/导入）前
 * 由 app._pushUndo() 记录 collectSnapshot 快照（空盘时快照为 null）。
 * 撤回 = 恢复快照（app._restoreSnapshot）：存活实例保持当前 params（参数不撤回），
 * 被删器件按快照恢复，导线/线标全量恢复。
 *
 * 栈管理：新操作清空 redo；容量 maxSteps（主配置 undo.maxSteps，缺省 50）。
 */

export class UndoManager {
  constructor(maxSteps = 50) {
    this.maxSteps = maxSteps;
    this.undoStack = [];   // 旧 → 新（栈顶为最近一次操作前的状态）
    this.redoStack = [];
  }

  push(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > this.maxSteps) this.undoStack.shift();   // 超容量丢最旧
    this.redoStack.length = 0;   // 新操作清空重做栈
  }

  /** 拖动未移动时丢弃刚记的快照 */
  discardLast() {
    this.undoStack.pop();
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** 撤回：返回目标快照；current 压入 redo 栈（供重做） */
  undo(current) {
    const t = this.undoStack.pop();
    if (t === undefined) return null;
    this.redoStack.push(current);
    return t;
  }

  /** 重做：返回目标快照；重做前的当前状态放回 undo 栈（恢复历史，供再次撤回） */
  redo(current) {
    const t = this.redoStack.pop();
    if (t === undefined) return null;
    this.undoStack.push(current);
    return t;
  }
}

/**
 * LCS 对齐两个器件 id 序列（快照组件 vs 当前实例）→ 配对 [[快照索引, 当前索引], ...]
 * 同 id 多实例按序列顺序一一对应；撤回只差一步操作，序列几乎相同，对齐可靠。
 */
export function lcsAlign(snapIds, curIds) {
  const n = snapIds.length, m = curIds.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = snapIds[i] === curIds[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (snapIds[i] === curIds[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}
