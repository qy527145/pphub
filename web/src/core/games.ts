// 游戏系统核心 - 游戏桌管理、旁观模式、实时同步

export type GameType = 'gomoku' | 'xiangqi' | 'drawguess' | 'doudizhu' | 'chomp'

export type GameCategory = 'single' | 'double' | 'multi'

/** 游戏元信息（游戏大厅展示用） */
export interface GameMeta {
  id: GameType
  name: string
  description: string
  category: GameCategory
  /**
   * 需要的玩家人数。single=1，double=固定人数；
   * multi 游戏以此为「最少开局人数」，实际上限见 maxPlayers。
   */
  playerCount: number
  /**
   * multi 游戏的人数上限（座位上限）。缺省时等于 playerCount（即固定人数，如斗地主）。
   * 你画我猜这类「人越多越好玩」的游戏据此放开到多个座位。
   */
  maxPlayers?: number
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
  /**
   * 桌主（当前权威节点）。桌子的所有状态变更只由桌主执行并广播，
   * 桌主掉线时由 electHost() 确定性改选（最小 peerId 优先玩家、次旁观）。
   */
  hostId: string
  /**
   * 权威版本号。只有桌主自增；接收端按 rev 单调合并 table-sync，
   * 旧 rev 不覆盖新值，从根本上消除座位竞争 / 脑裂。
   */
  rev: number
  /** 创建时间戳（用于匹配聚合的确定性排序与 GC）。 */
  createdAt: number
  /** 桌子状态 */
  state: TableState
  /** 公开/私有 */
  visibility: TableVisibility
  /** 是否有密码保护（= !!passwordHash，UI 展示用）。 */
  hasPassword?: boolean
  /**
   * 密码哈希（随桌同步）。诚实客户端据此校验 join 请求；
   * 威胁模型为「防误入」而非对抗恶意端（P2P 无服务器权威）。
   */
  passwordHash?: string
  /**
   * 是否为快速匹配自动创建的桌子：桌主在达到最少开局人数时自动开局，
   * 且允许同类空桌互相聚合到最小 tableId，避免匹配分散成多个单人桌。
   */
  autoStart?: boolean
  /** 玩家列表（peerId[]，按座位顺序） */
  players: string[]
  /**
   * 开局座位表：游戏开始时冻结一份 players 快照（下标 = 座位号）。
   * 对局中有人离席时 players 会被压缩，但 roster 保持不变，
   * 供棋类按稳定座位推导执子颜色，并让离席者凭原座位回来续战。
   */
  roster?: string[]
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
    description: '多人游戏，轮流画画，其他人猜词',
    category: 'multi',
    playerCount: 2, // 2 人起玩，人越多越热闹
    maxPlayers: 8,
    spectatable: true,
    shareCursor: false, // 仅出题人作画（画笔已同步），无需再共享指针
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

/** 最少开局人数（multi 游戏为 playerCount，其它同理）。 */
export function minPlayersOf(meta: GameMeta): number {
  return meta.playerCount
}

/** 座位上限：multi 游戏可放开到 maxPlayers，缺省等于 playerCount（固定人数）。 */
export function maxPlayersOf(meta: GameMeta): number {
  return meta.maxPlayers ?? meta.playerCount
}

/** 检查玩家数量是否满足游戏要求 */
export function canStartGame(gameType: GameType, playerCount: number): boolean {
  const meta = getGameMeta(gameType)
  if (!meta) return false

  // 单机游戏只需1人
  if (meta.category === 'single') return playerCount === 1

  // 双人游戏需要恰好2人
  if (meta.category === 'double') return playerCount === meta.playerCount

  // 多人游戏：达到最少人数且不超过座位上限
  return playerCount >= minPlayersOf(meta) && playerCount <= maxPlayersOf(meta)
}

/** 生成游戏桌 ID */
export function generateTableId(): string {
  return `table_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}
