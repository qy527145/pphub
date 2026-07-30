// 有毒的巧克力（Chomp）游戏逻辑 - 使用网格表示法

export interface ChompState {
  rows: number
  cols: number
  /** 网格表示：true 表示该位置还有巧克力，false 表示已被吃掉 */
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
    // 初始时所有格子都有巧克力
    grid: Array(rows * cols).fill(true),
  }
}

/** 获取格子索引 */
function getIndex(state: ChompState, row: number, col: number): number {
  return row * state.cols + col
}

/** 检查格子是否有巧克力 */
function hasChocolate(state: ChompState, row: number, col: number): boolean {
  if (row < 0 || row >= state.rows || col < 0 || col >= state.cols) {
    return false
  }
  return state.grid[getIndex(state, row, col)]
}

/** 检查位置是否可以吃（在剩余巧克力内） */
export function isValidChompMove(state: ChompState, move: ChompMove): boolean {
  const { row, col } = move
  return hasChocolate(state, row, col)
}

/** 吃掉巧克力 */
export function applyChompMove(state: ChompState, move: ChompMove): ChompState {
  const { row, col } = move
  const newGrid = [...state.grid]

  // 吃掉 (row, col) 及其右上方的所有巧克力
  // 右上方：r <= row 且 c >= col
  for (let r = 0; r <= row; r++) {
    for (let c = col; c < state.cols; c++) {
      newGrid[getIndex(state, r, c)] = false
    }
  }

  return {
    ...state,
    grid: newGrid,
  }
}

/** 检查游戏是否结束（只剩左下角有毒的巧克力） */
export function isChompGameOver(state: ChompState): boolean {
  // 检查是否只剩左下角 (rows-1, 0) 有巧克力
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      if (hasChocolate(state, r, c)) {
        // 如果不是左下角但还有巧克力，游戏未结束
        if (r !== state.rows - 1 || c !== 0) {
          return false
        }
      }
    }
  }
  // 只剩左下角有巧克力，或者所有巧克力都被吃完了
  return true
}

/** 获取所有可以吃的位置 */
export function getChompMoves(state: ChompState): ChompMove[] {
  const moves: ChompMove[] = []

  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      if (hasChocolate(state, r, c)) {
        moves.push({ row: r, col: c })
      }
    }
  }

  return moves
}

/** 将状态编码为字符串（用于记忆化） */
function encodeState(state: ChompState): string {
  return state.grid.map(v => v ? '1' : '0').join('')
}

/** 记忆化缓存：状态 -> 是否必胜 */
const winCache = new Map<string, boolean>()

/** 记忆化缓存：状态 -> 最佳下一步 */
const nextCache = new Map<string, ChompMove>()

/** 判断当前状态是否必胜 */
function isWinningPosition(state: ChompState): boolean {
  const key = encodeState(state)

  if (winCache.has(key)) {
    return winCache.get(key)!
  }

  // 如果游戏结束（只剩有毒的），当前玩家必须吃它，所以输
  if (isChompGameOver(state)) {
    winCache.set(key, false)
    return false
  }

  const moves = getChompMoves(state)

  // 过滤掉有毒的巧克力
  const validMoves = moves.filter(m => !(m.row === state.rows - 1 && m.col === 0))

  if (validMoves.length === 0) {
    // 只剩有毒的可以吃，必败
    winCache.set(key, false)
    return false
  }

  // 尝试每一步，如果存在让对手陷入必败态的走法，则当前必胜
  for (const move of validMoves) {
    const nextState = applyChompMove(state, move)
    if (!isWinningPosition(nextState)) {
      // 对手陷入必败态，我们必胜
      winCache.set(key, true)
      return true
    }
  }

  // 所有走法都让对手必胜，则当前必败
  winCache.set(key, false)
  return false
}

/** AI 找到最佳走法 */
export function findBestChompMove(state: ChompState): ChompMove | null {
  const key = encodeState(state)

  // 检查缓存
  if (nextCache.has(key)) {
    return nextCache.get(key)!
  }

  const moves = getChompMoves(state)
  if (moves.length === 0) return null

  // 如果只剩一个格子（有毒的），返回 null
  if (isChompGameOver(state)) return null

  // 过滤掉有毒的巧克力
  const validMoves = moves.filter(m => !(m.row === state.rows - 1 && m.col === 0))

  if (validMoves.length === 0) {
    // 只剩有毒的，不应该走棋
    return null
  }

  // 尝试找一步让对手陷入必败态
  for (const move of validMoves) {
    const nextState = applyChompMove(state, move)
    if (!isWinningPosition(nextState)) {
      // 这一步让对手陷入必败态
      nextCache.set(key, move)
      return move
    }
  }

  // 如果当前是必败态，选择第一个有效走法
  const move = validMoves[0]
  nextCache.set(key, move)
  return move
}

/** 清除缓存（开始新游戏时调用） */
export function clearChompCache(): void {
  winCache.clear()
  nextCache.clear()
}

/** 将网格转换为布尔数组（用于UI显示，保持接口兼容） */
export function boundaryToGrid(state: ChompState): boolean[] {
  return state.grid
}
