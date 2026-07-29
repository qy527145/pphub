// 有毒的巧克力（Chomp）游戏逻辑 - 记忆化搜索求最佳策略

export interface ChompState {
  rows: number
  cols: number
  /** 巧克力网格，true=还在，false=已吃掉（展平，行优先） */
  grid: boolean[]
}

export interface ChompMove {
  row: number
  col: number
}

/** 初始化巧克力棋盘 */
export function initChomp(rows: number, cols: number): ChompState {
  return {
    rows,
    cols,
    grid: Array(rows * cols).fill(true),
  }
}

/** 检查位置是否有效且还有巧克力 */
export function isValidChompMove(state: ChompState, move: ChompMove): boolean {
  const { row, col } = move
  if (row < 0 || row >= state.rows || col < 0 || col >= state.cols) return false
  return state.grid[row * state.cols + col]
}

/** 吃掉巧克力（从该位置到右上角全部吃掉） */
export function applyChompMove(state: ChompState, move: ChompMove): ChompState {
  const newGrid = [...state.grid]
  for (let r = move.row; r < state.rows; r++) {
    for (let c = move.col; c < state.cols; c++) {
      newGrid[r * state.cols + c] = false
    }
  }
  return { ...state, grid: newGrid }
}

/** 检查游戏是否结束（左下角有毒的巧克力被吃掉） */
export function isChompGameOver(state: ChompState): boolean {
  // 左下角 = (rows-1, 0)
  return !state.grid[(state.rows - 1) * state.cols + 0]
}

/** 获取所有合法的下一步 */
export function getChompMoves(state: ChompState): ChompMove[] {
  const moves: ChompMove[] = []
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      if (state.grid[r * state.cols + c]) {
        moves.push({ row: r, col: c })
      }
    }
  }
  return moves
}

/** 将棋盘状态编码为字符串（用于记忆化） */
function encodeChompState(state: ChompState): string {
  return state.grid.map((v) => (v ? '1' : '0')).join('')
}

/** 记忆化搜索：返回当前玩家是否必胜 */
const winCache = new Map<string, boolean>()

function isWinningPosition(state: ChompState): boolean {
  // 如果游戏已结束，当前玩家输（因为是对手吃掉了有毒的）
  if (isChompGameOver(state)) return false

  const key = encodeChompState(state)
  if (winCache.has(key)) return winCache.get(key)!

  const moves = getChompMoves(state)

  // 尝试所有走法，如果存在一步让对手陷入必败态，则当前为必胜态
  for (const move of moves) {
    const nextState = applyChompMove(state, move)
    if (!isWinningPosition(nextState)) {
      // 找到一步让对手必败
      winCache.set(key, true)
      return true
    }
  }

  // 所有走法都让对手必胜，则当前必败
  winCache.set(key, false)
  return false
}

/** AI 找到最佳走法（保证获胜的一步，如果存在） */
export function findBestChompMove(state: ChompState): ChompMove | null {
  const moves = getChompMoves(state)
  if (moves.length === 0) return null

  // 找到让对手陷入必败态的走法
  for (const move of moves) {
    const nextState = applyChompMove(state, move)
    if (!isWinningPosition(nextState)) {
      return move
    }
  }

  // 理论上不应该到这里（因为 Chomp 游戏先手必胜）
  // 但如果当前确实是必败态，随便返回第一步
  return moves[0]
}

/** 清除缓存（开始新游戏时调用） */
export function clearChompCache(): void {
  winCache.clear()
}

/** 预计算给定尺寸的最佳首步（可选优化） */
export function precomputeChompFirstMove(rows: number, cols: number): ChompMove | null {
  const state = initChomp(rows, cols)
  return findBestChompMove(state)
}
