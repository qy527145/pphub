// 有毒的巧克力（Chomp）游戏逻辑 - 使用边界点表示法的最佳策略

export interface ChompState {
  rows: number
  cols: number
  /** 边界点表示法：记录右上边界的点，例如 [[5,0], [3,2], [0,7]] 表示剩余的巧克力形状 */
  boundary: [number, number][]
}

export interface ChompMove {
  row: number
  col: number
}

/** 初始化巧克力棋盘（使用边界点表示） */
export function initChomp(rows: number, cols: number): ChompState {
  return {
    rows,
    cols,
    // 初始边界：右边界在最右列，上边界在最上行
    boundary: [[rows, 0], [0, cols]],
  }
}

/** 检查位置是否可以吃（在剩余巧克力内） */
export function isValidChompMove(state: ChompState, move: ChompMove): boolean {
  const { row, col } = move
  if (row < 0 || row >= state.rows || col < 0 || col >= state.cols) return false

  // 检查该位置是否在边界内（还有巧克力）
  return canEat(state.boundary, row, col)
}

/** 检查 (i, j) 位置是否可以吃 */
function canEat(boundary: [number, number][], i: number, j: number): boolean {
  // 检查是否有任何边界点在 (i,j) 的左下方（含等于）
  for (const [m, n] of boundary) {
    if (m <= i && n <= j) {
      return false
    }
  }
  return true
}

/** 吃掉巧克力（更新边界点） */
export function applyChompMove(state: ChompState, move: ChompMove): ChompState {
  const { row, col } = move
  const newBoundary = state.boundary.filter(([m, n]) => {
    // 移除在 (row, col) 右上方的边界点（含等于）
    return !(m >= row && n >= col)
  })

  // 添加新的边界点
  newBoundary.push([row, col])

  return {
    ...state,
    boundary: sortBoundary(newBoundary),
  }
}

/** 排序边界点（按行排序） */
function sortBoundary(boundary: [number, number][]): [number, number][] {
  return boundary.sort((a, b) => {
    if (a[0] < b[0]) return -1
    if (a[0] > b[0]) return 1
    return 0
  })
}

/** 检查游戏是否结束（只剩左下角有毒的巧克力） */
export function isChompGameOver(state: ChompState): boolean {
  // 游戏结束：边界只剩一个点 [0, 0]
  return state.boundary.length === 1 &&
         state.boundary[0][0] === 0 &&
         state.boundary[0][1] === 0
}

/** 获取所有可以吃的位置 */
export function getChompMoves(state: ChompState): ChompMove[] {
  const moves: ChompMove[] = []

  for (let i = 0; i < state.rows; i++) {
    for (let j = 0; j < state.cols; j++) {
      if (canEat(state.boundary, i, j)) {
        moves.push({ row: i, col: j })
      } else {
        // 当前行后面的位置都不能吃了
        break
      }
    }
  }

  return moves
}

/** 将边界编码为字符串（用于记忆化） */
function encodeBoundary(boundary: [number, number][]): string {
  return sortBoundary(boundary).toString()
}

/** 记忆化缓存：状态 -> 是否必胜 */
const winCache = new Map<string, boolean>()

/** 记忆化缓存：状态 -> 最佳下一步 */
const nextCache = new Map<string, ChompMove>()

/** 判断当前状态是否必胜 */
function isWinningPosition(state: ChompState): boolean {
  const key = encodeBoundary(state.boundary)

  if (winCache.has(key)) {
    return winCache.get(key)!
  }

  // 如果游戏结束（只剩有毒的），当前玩家输
  if (isChompGameOver(state)) {
    winCache.set(key, true) // 对手会输，所以这是必胜态（在吃之前）
    return true
  }

  // 实际结束判断：boundary 长度为 1 意味着只剩一个点了
  if (state.boundary.length === 1) {
    winCache.set(key, true)
    return true
  }

  const moves = getChompMoves(state)

  // 尝试每一步，如果存在让对手陷入必败态的走法，则当前必胜
  for (const move of moves) {
    const nextState = applyChompMove(state, move)
    if (!isWinningPosition(nextState)) {
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
  const key = encodeBoundary(state.boundary)

  // 检查缓存
  if (nextCache.has(key)) {
    return nextCache.get(key)!
  }

  const moves = getChompMoves(state)
  if (moves.length === 0) return null

  // 如果当前是必胜态，找一步让对手陷入必败态
  if (isWinningPosition(state)) {
    for (const move of moves) {
      const nextState = applyChompMove(state, move)
      if (!isWinningPosition(nextState)) {
        nextCache.set(key, move)
        return move
      }
    }
  }

  // 如果当前是必败态，随机选一步（但不选左下角）
  const sortedBoundary = sortBoundary([...state.boundary])
  // 避免直接吃左下角，选择一个边界点附近的位置
  if (sortedBoundary.length > 1) {
    // 选择第二个边界点前一格
    const [row, col] = sortedBoundary[1]
    const move = { row: Math.max(0, row - 1), col: Math.max(0, col - 1) }
    nextCache.set(key, move)
    return move
  }

  return moves[0]
}

/** 清除缓存（开始新游戏时调用） */
export function clearChompCache(): void {
  winCache.clear()
  nextCache.clear()
}

/** 将边界转换为网格表示（用于UI显示） */
export function boundaryToGrid(state: ChompState): boolean[] {
  const grid = Array(state.rows * state.cols).fill(false)

  for (let i = 0; i < state.rows; i++) {
    for (let j = 0; j < state.cols; j++) {
      if (canEat(state.boundary, i, j)) {
        grid[i * state.cols + j] = true
      }
    }
  }

  return grid
}
