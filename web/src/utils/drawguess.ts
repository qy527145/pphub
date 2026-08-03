// 你画我猜（桌内联机）纯逻辑：状态机 + 计分 + 出题人轮换。
//
// 同步模型（对齐斗地主/象棋）：状态经 game-move 全量广播，ver 单调递增防旧状态回灌。
// 一轮之内「当前出题人」是唯一写方（画笔、裁决、公布、翻页都由 TA 推进），
// 因此同一时刻不存在并发写，单槽 gameStates 也不会冲突。
//
// 谜底（word）绝不进入同步状态——只留在出题人本地，猜中由出题人裁决，
// 与白板版「出题人本地持词」一致。猜测走 game-chat（全桌可见），
// 出题人本地比对命中后才回填 winner/公布谜底。
import { pickWords, normalizeGuess } from './words'

export { pickWords, normalizeGuess }

export type DrawGuessPhase = 'picking' | 'drawing' | 'roundend' | 'gameover'

/** 一笔笔画：坐标量化到逻辑画布（见 DG_W/DG_H），渲染时按容器等比缩放。 */
export interface DGStroke {
  color: string
  size: number
  points: number[] // 扁平 [x0,y0,x1,y1,…]
}

export interface DrawGuessState {
  /** 单调递增版本号，防旧状态回灌。 */
  ver: number
  /** 参赛座位（开局冻结的 roster 顺序）。 */
  seats: string[]
  scores: Record<string, number>
  /** 当前第几轮（1-based）。 */
  round: number
  /** 总轮数 = 座位数（每人各当一次出题人）。 */
  totalRounds: number
  /** 当前出题人。 */
  drawerId: string
  phase: DrawGuessPhase
  /** 给猜的人的提示（如「3 个字」）。 */
  hint: string
  wordLen: number
  /** 已提交笔画。 */
  strokes: DGStroke[]
  /** 正在画的一笔（未提交），null 表示无。 */
  live: DGStroke | null
  /** 本轮猜中者（空串=尚无）。 */
  winnerId: string
  /** 回合结算时公布的谜底（空串=未公布）。 */
  revealedWord: string
  /** 作画倒计时截止（ms 时间戳，0=未开始）。 */
  roundEndsAt: number
}

/** 逻辑画布尺寸（笔画坐标空间；渲染时缩放到实际容器）。 */
export const DG_W = 1000
export const DG_H = 700

export const DRAW_SECONDS = 90
export const ROUND_END_SECONDS = 5
export const GUESS_POINTS = 2
export const DRAWER_POINTS = 1

export function isDrawGuessState(v: unknown): v is DrawGuessState {
  if (!v || typeof v !== 'object') return false
  const s = v as DrawGuessState
  return (
    Array.isArray(s.seats) &&
    typeof s.phase === 'string' &&
    Array.isArray(s.strokes) &&
    typeof s.ver === 'number'
  )
}

/** 开局：座位固定，比分清零，第一位出题人 = seats[0]，进入选词。 */
export function initDrawGuess(seats: string[]): DrawGuessState {
  const scores: Record<string, number> = {}
  for (const s of seats) scores[s] = 0
  return {
    ver: 1,
    seats: [...seats],
    scores,
    round: 1,
    totalRounds: Math.max(1, seats.length),
    drawerId: seats[0] || '',
    phase: 'picking',
    hint: '',
    wordLen: 0,
    strokes: [],
    live: null,
    winnerId: '',
    revealedWord: '',
    roundEndsAt: 0,
  }
}

/** 出题人选词，进入作画阶段。word 不入状态（只在出题人本地）；仅广播字数提示。 */
export function beginDrawing(s: DrawGuessState, word: string, now: number): DrawGuessState {
  const len = [...word.trim()].length
  return {
    ...s,
    ver: s.ver + 1,
    phase: 'drawing',
    wordLen: len,
    hint: `${len} 个字`,
    strokes: [],
    live: null,
    winnerId: '',
    revealedWord: '',
    roundEndsAt: now + DRAW_SECONDS * 1000,
  }
}

/** 裁决猜中：猜中者 +GUESS_POINTS、出题人 +DRAWER_POINTS，公布谜底并进入结算。 */
export function settleWin(s: DrawGuessState, winner: string, word: string): DrawGuessState {
  const scores = { ...s.scores }
  scores[winner] = (scores[winner] ?? 0) + GUESS_POINTS
  scores[s.drawerId] = (scores[s.drawerId] ?? 0) + DRAWER_POINTS
  return {
    ...s,
    ver: s.ver + 1,
    phase: 'roundend',
    winnerId: winner,
    revealedWord: word,
    scores,
    live: null,
  }
}

/** 无人猜中、时间到：公布谜底，进入结算（不记分）。 */
export function settleTimeout(s: DrawGuessState, word: string): DrawGuessState {
  return {
    ...s,
    ver: s.ver + 1,
    phase: 'roundend',
    winnerId: '',
    revealedWord: word,
    live: null,
  }
}

/**
 * 进入下一位出题人（按 seats 轮转）；轮数用尽则结束。
 * present 为「当前仍在座的 peerId 集合」，用于跳过已离席的座位（避免卡在空位上）。
 */
export function nextRound(s: DrawGuessState, present?: Set<string>): DrawGuessState {
  if (s.round >= s.totalRounds) {
    return { ...s, ver: s.ver + 1, phase: 'gameover', live: null, roundEndsAt: 0 }
  }
  const start = s.seats.indexOf(s.drawerId)
  let nextIdx = (start + 1) % s.seats.length
  if (present) {
    // 跳过已离席座位，最多绕一圈。
    for (let k = 0; k < s.seats.length; k++) {
      if (present.has(s.seats[nextIdx])) break
      nextIdx = (nextIdx + 1) % s.seats.length
    }
  }
  return {
    ...s,
    ver: s.ver + 1,
    round: s.round + 1,
    drawerId: s.seats[nextIdx] || s.drawerId,
    phase: 'picking',
    hint: '',
    wordLen: 0,
    strokes: [],
    live: null,
    winnerId: '',
    revealedWord: '',
    roundEndsAt: 0,
  }
}

/**
 * 出题人离席时把出题权交给下一位在座者（host 兜底调用，避免整局卡死）。
 * 找不到任何在座者时原样返回。
 */
export function reassignDrawer(s: DrawGuessState, present: Set<string>): DrawGuessState {
  const start = s.seats.indexOf(s.drawerId)
  for (let k = 1; k <= s.seats.length; k++) {
    const idx = (start + k) % s.seats.length
    const cand = s.seats[idx]
    if (present.has(cand)) {
      return {
        ...s,
        ver: s.ver + 1,
        drawerId: cand,
        phase: 'picking',
        hint: '',
        wordLen: 0,
        strokes: [],
        live: null,
        winnerId: '',
        revealedWord: '',
        roundEndsAt: 0,
      }
    }
  }
  return s
}
