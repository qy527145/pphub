// 游戏系统核心 - 游戏桌管理、旁观模式、实时同步

export type GameType = 'gomoku' | 'xiangqi' | 'drawguess' | 'doudizhu' | 'chomp'

export type GameCategory = 'single' | 'double' | 'multi'

/** 游戏元信息（游戏大厅展示用） */
export interface GameMeta {
  id: GameType
  name: string
  description: string
  category: GameCategory
  /** 需要的玩家人数（单机游戏为 1，对战游戏为具体人数） */
  playerCount: number
  /** 是否支持旁观 */
  spectatable: boolean
  /**
   * 是否在桌内共享鼠标指针。棋类/画图类指向棋盘有意义；
   * 手牌类（斗地主）各自手牌保密，共享指针无意义且会暴露操作意图，故关闭。
   */
  shareCursor: boolean
  icon: string
}

/** 游戏桌状态 */
export type TableState = 'waiting' | 'playing' | 'finished'

/** 游戏桌可见性 */
export type TableVisibility = 'public' | 'private'

/** 玩家在桌上的角色 */
export type PlayerRole = 'player' | 'spectator'

/** 游戏桌（一局游戏的容器） */
export interface GameTable {
  tableId: string
  /** 4-6位数字桌号（用户友好的加入方式） */
  tableNumber?: string
  gameType: GameType
  /** 桌主（创建者） */
  hostId: string
  /** 桌子状态 */
  state: TableState
  /** 公开/私有 */
  visibility: TableVisibility
  /** 是否有密码保护 */
  hasPassword?: boolean
  /** 玩家列表（peerId[]，按座位顺序） */
  players: string[]
  /** 旁观者列表 */
  spectators: string[]
  /** 游戏开始时间戳 */
  startedAt?: number
  /** 游戏结束时间戳 */
  finishedAt?: number
  /** 游戏特定配置（如巧克力长宽、超时设置等） */
  config?: Record<string, unknown>
  /** 游戏状态数据（游戏逻辑专用，每个游戏自己定义） */
  gameState?: unknown
}

/** 游戏桌消息类型 */
export type GameTableMessageType =
  | 'table-create'     // 创建游戏桌
  | 'table-join'       // 加入游戏桌（作为玩家）
  | 'table-spectate'   // 加入游戏桌（作为旁观者）
  | 'table-leave'      // 离开游戏桌
  | 'table-start'      // 开始游戏
  | 'table-state'      // 同步游戏桌状态
  | 'game-move'        // 游戏动作（落子、出牌等）
  | 'game-chat'        // 游戏内聊天
  | 'game-timeout'     // 超时
  | 'game-undo'        // 悔棋请求
  | 'game-undo-resp'   // 悔棋响应
  | 'mouse-pos'        // 鼠标位置共享

export interface GameTableMessage {
  type: GameTableMessageType
  tableId: string
  from: string
  data: unknown
  ts: number
}

/** 游戏动作（通用接口，具体游戏继承扩展） */
export interface GameMove {
  player: string
  moveIndex: number
  ts: number
}

/** 游戏内聊天消息 */
export interface GameChatMessage {
  from: string
  text: string
  ts: number
  role: PlayerRole
}

/** 鼠标位置 */
export interface MousePosition {
  peerId: string
  x: number  // 0-1 归一化坐标
  y: number  // 0-1 归一化坐标
  ts: number
}

/** 悔棋请求 */
export interface UndoRequest {
  from: string
  moveIndex: number  // 要撤销到哪一步
}

/** 悔棋响应 */
export interface UndoResponse {
  from: string
  accepted: boolean
}

// ===== 游戏目录 =====

export const GAME_CATALOG: GameMeta[] = [
  {
    id: 'gomoku',
    name: '五子棋',
    description: '双人对弈，五子连珠获胜',
    category: 'double',
    playerCount: 2,
    spectatable: true,
    shareCursor: true,
    icon: '⚫',
  },
  {
    id: 'xiangqi',
    name: '中国象棋',
    description: '双人对弈，将死对方获胜',
    category: 'double',
    playerCount: 2,
    spectatable: true,
    shareCursor: true,
    icon: '♟️',
  },
  {
    id: 'drawguess',
    name: '你画我猜',
    description: '多人游戏，一人画其他人猜',
    category: 'multi',
    playerCount: 3,  // 最少3人，可更多
    spectatable: true,
    shareCursor: true,
    icon: '🎨',
  },
  {
    id: 'doudizhu',
    name: '斗地主',
    description: '三人扑克游戏，地主对战农民',
    category: 'multi',
    playerCount: 3,
    spectatable: true,
    shareCursor: false,
    icon: '🃏',
  },
  {
    id: 'chomp',
    name: '有毒的巧克力',
    description: '单机游戏，对战 AI 必胜策略',
    category: 'single',
    playerCount: 1,
    spectatable: false,
    shareCursor: false,
    icon: '🍫',
  },
]

/** 根据游戏类型获取元信息 */
export function getGameMeta(gameType: GameType): GameMeta | undefined {
  return GAME_CATALOG.find((g) => g.id === gameType)
}

/** 检查玩家数量是否满足游戏要求 */
export function canStartGame(gameType: GameType, playerCount: number): boolean {
  const meta = getGameMeta(gameType)
  if (!meta) return false

  // 单机游戏只需1人
  if (meta.category === 'single') return playerCount === 1

  // 双人游戏需要恰好2人
  if (meta.category === 'double') return playerCount === meta.playerCount

  // 多人游戏需要至少达到最少人数
  return playerCount >= meta.playerCount
}

/** 生成游戏桌 ID */
export function generateTableId(): string {
  return `table_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}
