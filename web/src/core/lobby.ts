// 游戏大厅纯工具层 —— 不持有状态、不做副作用，只提供确定性的规则函数与协议数据类型。
// 状态与编排全部收敛到 room.ts（桌主权威模型），本模块只被 messages.ts / room.ts / 组件引用。

import type { GameType, GameTable } from './games'
import { getGameMeta, maxPlayersOf } from './games'

/** 非桌主向桌主发起的座位类请求动作。 */
export type TableAction = 'join' | 'spectate' | 'sit' | 'standup' | 'leave'

/** 邀请（点对点定向下发，不进大厅广播）。 */
export interface Invitation {
  inviteId: string
  fromPeerId: string
  toPeerId: string
  tableId: string
  tableNumber?: string
  gameType: GameType
  message?: string
  createdAt: number
}

/** 象棋开局配置协商提案（先手方 / 计时，双方 propose/accept 收敛）。 */
export interface XiangqiProposal {
  redSeat: 0 | 1
  gameTimeSec: number
  moveTimeSec: number
  /** 提议方 peerId。 */
  by: string
}

/**
 * 确定性选主：候选中最小 peerId 者当选，玩家优先于旁观者。
 * 所有节点对同一集合得到同一结果，故桌主掉线时无需协商即可无脑裂改选。
 */
export function electHost(players: string[], spectators: string[]): string | null {
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const p = [...players].sort(byId)
  if (p.length) return p[0]
  const s = [...spectators].sort(byId)
  return s.length ? s[0] : null
}

/**
 * 密码哈希。P2P 无服务器权威，威胁模型是「防误入公开桌」而非对抗恶意端，
 * 故用轻量不可逆散列即可（避免明文随桌广播）。空密码返回 undefined。
 */
export function hashPassword(password: string | undefined): string | undefined {
  if (!password) return undefined
  let h = 0x811c9dc5
  for (let i = 0; i < password.length; i++) {
    h ^= password.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 校验明文密码是否匹配桌子的哈希（无密码桌恒真）。 */
export function verifyPassword(table: GameTable, password: string | undefined): boolean {
  if (!table.passwordHash) return true
  return hashPassword(password) === table.passwordHash
}

/**
 * 能否入座为玩家（纯判定，不含身份/密码校验）：桌子处于等待、未满员，
 * 或对局中「原座位续战」（roster 中有我的位置且当前空缺）。
 */
export function canSit(table: GameTable, peerId: string): boolean {
  const meta = getGameMeta(table.gameType)
  if (!meta) return false
  if (table.players.includes(peerId)) return true
  const cap = maxPlayersOf(meta)

  if (table.state === 'waiting') return table.players.length < cap

  // 对局中：仅允许 roster 里的原玩家回到自己空出的座位续战。
  if (table.state === 'playing' && table.roster) {
    return table.roster.includes(peerId) && table.players.length < cap
  }
  return false
}

/** 生成一个不与 taken 冲突的 4 位数字桌号（seed 用于确定性/无 Math.random 依赖）。 */
export function genTableNumber(taken: Set<string>, seed: number): string {
  let n = 1000 + (Math.abs(seed) % 9000)
  for (let i = 0; i < 9000; i++) {
    const s = String(n)
    if (!taken.has(s)) return s
    n = n >= 9999 ? 1000 : n + 1
  }
  return String(1000 + (taken.size % 9000))
}
