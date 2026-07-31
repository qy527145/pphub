// 中国象棋游戏逻辑（简化版，足够对弈使用）

export const XIANGQI_ROWS = 10
export const XIANGQI_COLS = 9

/** 棋子类型 */
export type PieceType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P'
// K=将/帅 A=士 B=象/相 N=马 R=车 C=炮 P=兵/卒

/** 棋子颜色 */
export type PieceColor = 'red' | 'black'

/** 棋子 */
export interface Piece {
  type: PieceType
  color: PieceColor
}

/** 棋盘位置 */
export interface Position {
  row: number
  col: number
}

/** 象棋走法 */
export interface XiangqiMove {
  from: Position
  to: Position
  captured?: Piece
}

/** 对局时钟（局时 + 步时，超时判负） */
export interface XiangqiClock {
  /** 局时上限（秒），0=不限 */
  gameTimeSec: number
  /** 步时上限（秒），0=不限 */
  moveTimeSec: number
  /** 红方局时剩余（秒） */
  redLeft: number
  /** 黑方局时剩余（秒） */
  blackLeft: number
  /** 当前回合步时剩余（秒） */
  moveLeft: number
  /** 当前回合开始时间戳（ms，走子方本地时间） */
  turnStartedAt: number
}

/** 开局设置（先后手 + 时限），开局前双方协商一致 */
export interface XiangqiConfig {
  /** 执红（先手）的座位号（table.players 下标 0/1） */
  redSeat: 0 | 1
  /** 局时上限（秒），0=不限 */
  gameTimeSec: number
  /** 步时上限（秒），0=不限 */
  moveTimeSec: number
}

/** 象棋棋盘状态 */
export interface XiangqiState {
  /** 棋盘（展平，行优先，null=空位） */
  board: (Piece | null)[]
  /** 当前回合 */
  turn: PieceColor
  /** 走法历史 */
  history: XiangqiMove[]
  /** 游戏状态 */
  status: 'playing' | 'checkmate' | 'stalemate' | 'draw' | 'timeout'
  /** 获胜方 */
  winner?: PieceColor
  /** 对局时钟（未设置时限则为空） */
  clock?: XiangqiClock
}

/** 初始化象棋棋盘 */
export function initXiangqi(): XiangqiState {
  const board: (Piece | null)[] = Array(XIANGQI_ROWS * XIANGQI_COLS).fill(null)

  // 黑方（上方，行0-4）
  const blackSetup: [number, number, PieceType][] = [
    [0, 0, 'R'], [0, 1, 'N'], [0, 2, 'B'], [0, 3, 'A'], [0, 4, 'K'],
    [0, 5, 'A'], [0, 6, 'B'], [0, 7, 'N'], [0, 8, 'R'],
    [2, 1, 'C'], [2, 7, 'C'],
    [3, 0, 'P'], [3, 2, 'P'], [3, 4, 'P'], [3, 6, 'P'], [3, 8, 'P'],
  ]
  for (const [r, c, t] of blackSetup) {
    board[r * XIANGQI_COLS + c] = { type: t, color: 'black' }
  }

  // 红方（下方，行5-9）
  const redSetup: [number, number, PieceType][] = [
    [9, 0, 'R'], [9, 1, 'N'], [9, 2, 'B'], [9, 3, 'A'], [9, 4, 'K'],
    [9, 5, 'A'], [9, 6, 'B'], [9, 7, 'N'], [9, 8, 'R'],
    [7, 1, 'C'], [7, 7, 'C'],
    [6, 0, 'P'], [6, 2, 'P'], [6, 4, 'P'], [6, 6, 'P'], [6, 8, 'P'],
  ]
  for (const [r, c, t] of redSetup) {
    board[r * XIANGQI_COLS + c] = { type: t, color: 'red' }
  }

  return {
    board,
    turn: 'red',
    history: [],
    status: 'playing',
  }
}

/** 获取棋盘上的棋子 */
export function getPiece(state: XiangqiState, pos: Position): Piece | null {
  if (pos.row < 0 || pos.row >= XIANGQI_ROWS || pos.col < 0 || pos.col >= XIANGQI_COLS) {
    return null
  }
  return state.board[pos.row * XIANGQI_COLS + pos.col]
}

/** 设置棋盘位置 */
function setPiece(state: XiangqiState, pos: Position, piece: Piece | null): void {
  state.board[pos.row * XIANGQI_COLS + pos.col] = piece
}

/** 检查位置是否在九宫内 */
function inPalace(pos: Position, color: PieceColor): boolean {
  const { row, col } = pos
  if (col < 3 || col > 5) return false
  if (color === 'red') return row >= 7 && row <= 9
  return row >= 0 && row <= 2
}

/** 检查象是否过河 */
function elephantCrossedRiver(pos: Position, color: PieceColor): boolean {
  if (color === 'red') return pos.row < 5
  return pos.row > 4
}

/** 检查兵是否过河 */
function pawnCrossedRiver(pos: Position, color: PieceColor): boolean {
  if (color === 'red') return pos.row < 5
  return pos.row > 4
}

/** 获取两点间的所有位置（不含起终点，用于检查炮/车的路径） */
function getPathBetween(from: Position, to: Position): Position[] {
  const path: Position[] = []
  if (from.row === to.row) {
    // 横向
    const minCol = Math.min(from.col, to.col)
    const maxCol = Math.max(from.col, to.col)
    for (let c = minCol + 1; c < maxCol; c++) {
      path.push({ row: from.row, col: c })
    }
  } else if (from.col === to.col) {
    // 纵向
    const minRow = Math.min(from.row, to.row)
    const maxRow = Math.max(from.row, to.row)
    for (let r = minRow + 1; r < maxRow; r++) {
      path.push({ row: r, col: from.col })
    }
  }
  return path
}

/** 检查路径是否畅通（无子） */
function isPathClear(state: XiangqiState, from: Position, to: Position): boolean {
  const path = getPathBetween(from, to)
  return path.every((pos) => getPiece(state, pos) === null)
}

/** 统计路径上的棋子数 */
function countPiecesInPath(state: XiangqiState, from: Position, to: Position): number {
  const path = getPathBetween(from, to)
  return path.filter((pos) => getPiece(state, pos) !== null).length
}

/** 检查走法是否合法（不考虑将军） */
export function isValidXiangqiMove(state: XiangqiState, move: XiangqiMove): boolean {
  const piece = getPiece(state, move.from)
  if (!piece || piece.color !== state.turn) return false

  const target = getPiece(state, move.to)
  if (target && target.color === piece.color) return false

  const dr = move.to.row - move.from.row
  const dc = move.to.col - move.from.col
  const adr = Math.abs(dr)
  const adc = Math.abs(dc)

  switch (piece.type) {
    case 'K': // 将/帅：九宫内一格
      if (!inPalace(move.to, piece.color)) return false
      if (adr + adc !== 1) return false
      return true

    case 'A': // 士：九宫内斜线一格
      if (!inPalace(move.to, piece.color)) return false
      if (adr !== 1 || adc !== 1) return false
      return true

    case 'B': // 象/相：田字，不过河
      if (elephantCrossedRiver(move.to, piece.color)) return false
      if (adr !== 2 || adc !== 2) return false
      // 检查象眼
      const eyeRow = move.from.row + dr / 2
      const eyeCol = move.from.col + dc / 2
      return getPiece(state, { row: eyeRow, col: eyeCol }) === null

    case 'N': // 马：日字，检查马腿
      if (!((adr === 2 && adc === 1) || (adr === 1 && adc === 2))) return false
      const legRow = adr === 2 ? move.from.row + dr / 2 : move.from.row
      const legCol = adc === 2 ? move.from.col + dc / 2 : move.from.col
      return getPiece(state, { row: legRow, col: legCol }) === null

    case 'R': // 车：直线，路径畅通
      if (dr !== 0 && dc !== 0) return false
      return isPathClear(state, move.from, move.to)

    case 'C': // 炮：直线，吃子需隔一子，移动需路径畅通
      if (dr !== 0 && dc !== 0) return false
      if (target) {
        return countPiecesInPath(state, move.from, move.to) === 1
      } else {
        return isPathClear(state, move.from, move.to)
      }

    case 'P': // 兵/卒：向前或过河后横向
      const crossed = pawnCrossedRiver(move.from, piece.color)
      if (piece.color === 'red') {
        if (dr === -1 && dc === 0) return true
        if (crossed && dr === 0 && adc === 1) return true
      } else {
        if (dr === 1 && dc === 0) return true
        if (crossed && dr === 0 && adc === 1) return true
      }
      return false
  }

  return false
}

/** 应用走法（不检查合法性） */
export function applyXiangqiMove(state: XiangqiState, move: XiangqiMove): XiangqiState {
  const newState: XiangqiState = {
    board: [...state.board],
    turn: state.turn === 'red' ? 'black' : 'red',
    history: [...state.history, move],
    status: state.status,
    winner: state.winner,
    clock: state.clock,
  }

  const piece = getPiece(newState, move.from)
  setPiece(newState, move.to, piece)
  setPiece(newState, move.from, null)

  return newState
}

/** 获取所有合法走法（简化版，不检查将军） */
export function getXiangqiMoves(state: XiangqiState, pos: Position): Position[] {
  const moves: Position[] = []
  const piece = getPiece(state, pos)
  if (!piece || piece.color !== state.turn) return moves

  for (let r = 0; r < XIANGQI_ROWS; r++) {
    for (let c = 0; c < XIANGQI_COLS; c++) {
      const to = { row: r, col: c }
      if (isValidXiangqiMove(state, { from: pos, to })) {
        moves.push(to)
      }
    }
  }

  return moves
}

/** 检查是否将军（简化版） */
export function isInCheck(state: XiangqiState, color: PieceColor): boolean {
  // 找到将/帅的位置
  let kingPos: Position | null = null
  for (let i = 0; i < state.board.length; i++) {
    const piece = state.board[i]
    if (piece && piece.type === 'K' && piece.color === color) {
      kingPos = { row: Math.floor(i / XIANGQI_COLS), col: i % XIANGQI_COLS }
      break
    }
  }
  if (!kingPos) return false

  // 检查是否有对方棋子能吃掉将/帅
  const opponentColor = color === 'red' ? 'black' : 'red'
  for (let i = 0; i < state.board.length; i++) {
    const piece = state.board[i]
    if (piece && piece.color === opponentColor) {
      const from = { row: Math.floor(i / XIANGQI_COLS), col: i % XIANGQI_COLS }
      const testMove: XiangqiMove = { from, to: kingPos }
      if (isValidXiangqiMove(state, testMove)) {
        return true
      }
    }
  }

  return false
}

// ===== 时钟（局时 + 步时） =====

/** 依据开局设置创建初始时钟；无任何时限时返回 undefined。 */
export function createClock(config: XiangqiConfig, now: number): XiangqiClock | undefined {
  if (config.gameTimeSec <= 0 && config.moveTimeSec <= 0) return undefined
  return {
    gameTimeSec: config.gameTimeSec,
    moveTimeSec: config.moveTimeSec,
    redLeft: config.gameTimeSec,
    blackLeft: config.gameTimeSec,
    moveLeft: config.moveTimeSec,
    turnStartedAt: now,
  }
}

/**
 * 走子方结束本回合时结算时钟：先消耗步时，步时用尽的溢出部分再扣局时；
 * 随后为下一回合重置步时并记录新的回合开始时间。返回结算后的新时钟。
 */
export function tickClockOnMove(
  clock: XiangqiClock,
  mover: PieceColor,
  now: number,
): XiangqiClock {
  const elapsed = Math.max(0, (now - clock.turnStartedAt) / 1000)
  const overflow = Math.max(0, elapsed - clock.moveLeft)
  const nextGameLeft = mover === 'red' ? clock.redLeft : clock.blackLeft
  const remaining = clock.gameTimeSec > 0 ? Math.max(0, nextGameLeft - overflow) : nextGameLeft
  return {
    ...clock,
    redLeft: mover === 'red' ? remaining : clock.redLeft,
    blackLeft: mover === 'black' ? remaining : clock.blackLeft,
    moveLeft: clock.moveTimeSec,
    turnStartedAt: now,
  }
}

/** 计算某方在 now 时刻的实时剩余（步时、局时）。仅对当前行棋方 elapsed 才有意义。 */
export function clockRemaining(
  clock: XiangqiClock,
  color: PieceColor,
  isActive: boolean,
  now: number,
): { moveLeft: number; gameLeft: number } {
  const bank = color === 'red' ? clock.redLeft : clock.blackLeft
  if (!isActive) {
    return { moveLeft: clock.moveTimeSec, gameLeft: bank }
  }
  const elapsed = Math.max(0, (now - clock.turnStartedAt) / 1000)
  const moveLeft = Math.max(0, clock.moveLeft - elapsed)
  const overflow = Math.max(0, elapsed - clock.moveLeft)
  const gameLeft = clock.gameTimeSec > 0 ? Math.max(0, bank - overflow) : bank
  return { moveLeft, gameLeft }
}

/** 当前行棋方是否已超时（局时耗尽判负）。局时不限则永不超时。 */
export function isTimedOut(clock: XiangqiClock, color: PieceColor, now: number): boolean {
  if (clock.gameTimeSec <= 0) return false
  return clockRemaining(clock, color, true, now).gameLeft <= 0
}
