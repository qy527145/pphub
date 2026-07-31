// 斗地主游戏逻辑（简化版）

export type CardSuit = 'spade' | 'heart' | 'club' | 'diamond' | 'joker'
export type CardRank = '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A' | '2' | 'small' | 'big'

export interface Card {
  suit: CardSuit
  rank: CardRank
}

export type HandType =
  | 'single'       // 单张
  | 'pair'         // 对子
  | 'triple'       // 三张
  | 'triple-one'   // 三带一
  | 'triple-pair'  // 三带二
  | 'straight'     // 顺子（5张及以上）
  | 'pair-straight'// 连对（3对及以上）
  | 'airplane'     // 飞机（2个及以上三张）
  | 'bomb'         // 炸弹
  | 'rocket'       // 王炸

export interface PlayedHand {
  cards: Card[]
  type: HandType
  player: string
}

export interface DoudizhuState {
  /**
   * 座位 → 玩家 peerId 的映射（长度 3）。开局时由桌主随机打乱 table.players 得到，
   * 随全量状态广播，确保各端座位一致。手牌 hands[i] 属于 seats[i]。
   */
  seats: string[]
  /** 三个玩家的手牌 */
  hands: [Card[], Card[], Card[]]
  /** 底牌（3张） */
  lordCards: Card[]
  /** 地主索引（0/1/2） */
  lordIndex: number | null
  /** 当前回合玩家索引 */
  currentPlayer: number
  /** 本局首个叫地主的座位（随机），叫牌按 firstBidder → +1 → +2 顺序进行 */
  firstBidder: number
  /** 最后出的牌 */
  lastPlay: PlayedHand | null
  /** 游戏阶段 */
  phase: 'bidding' | 'playing' | 'finished'
  /** 当前叫地主轮次 */
  bids: (0 | 1 | 2 | 3)[]  // 0=不叫，1-3=叫地主（分数）
  /** 游戏结果 */
  winner?: 'lord' | 'peasants'
  /** 单调递增的状态版本号（每次状态转移 +1，供对端判断新旧、包括过牌） */
  moveCount: number
}

const RANK_ORDER: CardRank[] = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', 'small', 'big']

/** 获取牌的排序值 */
export function getCardValue(card: Card): number {
  return RANK_ORDER.indexOf(card.rank)
}

/** 生成一副牌（54张） */
export function createDeck(): Card[] {
  const deck: Card[] = []
  const suits: CardSuit[] = ['spade', 'heart', 'club', 'diamond']
  const ranks: CardRank[] = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank })
    }
  }

  deck.push({ suit: 'joker', rank: 'small' })
  deck.push({ suit: 'joker', rank: 'big' })

  return deck
}

/** 洗牌（Fisher–Yates，返回新数组，可用于任意元素类型） */
export function shuffle<T>(arr: T[]): T[] {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/** 洗牌（保留旧名，供牌堆使用） */
export function shuffleDeck(deck: Card[]): Card[] {
  return shuffle(deck)
}

/**
 * 初始化斗地主游戏。
 * @param players 桌上玩家 peerId（长度 3），座位会被随机打乱后固定到本局。
 * @param startMoveCount 起始版本号；「再来一局」时传上一局的 moveCount+1，
 *   保证新状态的 moveCount 严格大于旧值，各端才会采纳（否则被当作旧状态忽略）。
 *
 * 座位随机（seats 打乱）+ 叫地主起手随机（firstBidder），使每局的位置与叫牌顺序都不固定。
 */
export function initDoudizhu(players: string[], startMoveCount = 0): DoudizhuState {
  const deck = shuffleDeck(createDeck())
  const seats = shuffle(players).slice(0, 3)
  const firstBidder = Math.floor(Math.random() * 3)

  return {
    seats,
    hands: [
      deck.slice(0, 17),
      deck.slice(17, 34),
      deck.slice(34, 51),
    ],
    lordCards: deck.slice(51, 54),
    lordIndex: null,
    currentPlayer: firstBidder,
    firstBidder,
    lastPlay: null,
    phase: 'bidding',
    bids: [],
    moveCount: startMoveCount,
  }
}

/** 排序手牌 */
export function sortHand(hand: Card[]): Card[] {
  return [...hand].sort((a, b) => getCardValue(a) - getCardValue(b))
}

/** 识别牌型 */
export function identifyHandType(cards: Card[]): HandType | null {
  if (cards.length === 0) return null

  const sorted = sortHand(cards)
  const counts = new Map<CardRank, number>()

  for (const card of sorted) {
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1)
  }

  // 单张
  if (cards.length === 1) return 'single'

  // 对子
  if (cards.length === 2 && counts.size === 1) return 'pair'

  // 王炸
  if (cards.length === 2 && sorted[0].rank === 'small' && sorted[1].rank === 'big') {
    return 'rocket'
  }

  // 三张
  if (cards.length === 3 && counts.size === 1) return 'triple'

  // 炸弹
  if (cards.length === 4 && counts.size === 1) return 'bomb'

  // 三带一
  if (cards.length === 4 && (Array.from(counts.values()).includes(3))) {
    return 'triple-one'
  }

  // 三带二
  if (cards.length === 5 && Array.from(counts.values()).sort().join(',') === '2,3') {
    return 'triple-pair'
  }

  // 顺子（5张及以上，连续）
  if (cards.length >= 5 && counts.size === cards.length) {
    const values = sorted.map(getCardValue)
    let isConsecutive = true
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1] + 1) {
        isConsecutive = false
        break
      }
    }
    // 2和王不能在顺子中
    if (isConsecutive && !sorted.some(c => ['2', 'small', 'big'].includes(c.rank))) {
      return 'straight'
    }
  }

  // 连对（3对及以上）
  if (cards.length >= 6 && cards.length % 2 === 0 && Array.from(counts.values()).every(v => v === 2)) {
    const ranks = Array.from(counts.keys())
    const values = ranks.map(r => RANK_ORDER.indexOf(r))
    let isConsecutive = true
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1] + 1) {
        isConsecutive = false
        break
      }
    }
    if (isConsecutive && ranks.length >= 3) {
      return 'pair-straight'
    }
  }

  // 飞机（暂不实现复杂带牌逻辑）
  const triples = Array.from(counts.entries()).filter(([_, count]) => count === 3)
  if (triples.length >= 2) {
    return 'airplane'
  }

  return null
}

/** 比较两手牌大小（返回true表示hand1更大） */
export function compareHands(hand1: PlayedHand, hand2: PlayedHand): boolean {
  // 王炸最大
  if (hand1.type === 'rocket') return true
  if (hand2.type === 'rocket') return false

  // 炸弹大于非炸弹
  if (hand1.type === 'bomb' && hand2.type !== 'bomb') return true
  if (hand2.type === 'bomb' && hand1.type !== 'bomb') return false

  // 牌型必须相同
  if (hand1.type !== hand2.type) return false

  // 比较主牌值
  const val1 = getCardValue(sortHand(hand1.cards)[hand1.cards.length - 1])
  const val2 = getCardValue(sortHand(hand2.cards)[hand2.cards.length - 1])

  return val1 > val2
}

/** 检查是否可以出牌 */
export function canPlayHand(cards: Card[], lastPlay: PlayedHand | null): boolean {
  const handType = identifyHandType(cards)
  if (!handType) return false

  // 第一手牌或上家过牌
  if (!lastPlay) return true

  // 王炸或炸弹可以压任何牌
  if (handType === 'rocket' || handType === 'bomb') return true

  // 牌型相同且数量相同才能比较
  if (handType !== lastPlay.type || cards.length !== lastPlay.cards.length) {
    return false
  }

  return compareHands({ cards, type: handType, player: '' }, lastPlay)
}

// ===== 对局推进（纯函数，均返回新状态；由「当前行动玩家」调用后广播全量状态）=====

/**
 * 叫地主。bidding 阶段从 firstBidder 开始按 firstBidder→+1→+2 顺序叫分（0=不叫，1-3=叫）。
 * 有人叫 3 分或三家都叫过后立即定地主：最高分者为地主，收 3 张底牌，进入出牌阶段。
 * 三家都不叫则默认首叫者为地主（简化处理，避免重新发牌导致各端牌不一致）。
 */
export function placeBid(state: DoudizhuState, playerIndex: number, bid: 0 | 1 | 2 | 3): DoudizhuState {
  if (state.phase !== 'bidding' || state.currentPlayer !== playerIndex) return state

  const bids = [...state.bids]
  bids[playerIndex] = bid // 叫分按座位索引记录

  // 已叫分的人数（bids 可能因随机起手而稀疏，用 filter 跳过空洞而非 length）
  const placed = bids.filter((b) => b !== undefined).length
  const done = bid === 3 || placed === 3
  if (!done) {
    return { ...state, bids, currentPlayer: (playerIndex + 1) % 3, moveCount: state.moveCount + 1 }
  }

  // 定地主：最高分者；并列时取叫牌顺序中较早的一位（从 firstBidder 起遍历）
  let lordIndex = state.firstBidder
  let best = -1
  for (let i = 0; i < 3; i++) {
    const seat = (state.firstBidder + i) % 3
    const b = bids[seat] ?? 0
    if (b > best) {
      best = b
      lordIndex = seat
    }
  }

  const hands = state.hands.map((h) => [...h]) as [Card[], Card[], Card[]]
  hands[lordIndex] = sortHand([...hands[lordIndex], ...state.lordCards])

  return {
    ...state,
    bids,
    hands,
    lordIndex,
    phase: 'playing',
    currentPlayer: lordIndex,
    lastPlay: null,
    moveCount: state.moveCount + 1,
  }
}

/** 出一手牌。非法（牌型不成立/压不过上家/手牌中无此牌）时原样返回。 */
export function playCards(state: DoudizhuState, playerIndex: number, cards: Card[]): DoudizhuState {
  if (state.phase !== 'playing' || state.currentPlayer !== playerIndex) return state

  const type = identifyHandType(cards)
  if (!type) return state

  // 需要压过上家（除非是自己领出的自由回合）
  const mustBeat = state.lastPlay !== null && Number(state.lastPlay.player) !== playerIndex
  if (mustBeat && !canPlayHand(cards, state.lastPlay)) return state

  // 从手牌中移除打出的牌
  const hand = [...state.hands[playerIndex]]
  for (const c of cards) {
    const i = hand.findIndex((h) => h.rank === c.rank && h.suit === c.suit)
    if (i === -1) return state
    hand.splice(i, 1)
  }
  const hands = state.hands.map((h, i) => (i === playerIndex ? hand : h)) as [Card[], Card[], Card[]]
  const played: PlayedHand = { cards, type, player: String(playerIndex) }

  // 打光即结束：地主赢则 lord，否则 peasants
  if (hand.length === 0) {
    return {
      ...state,
      hands,
      lastPlay: played,
      phase: 'finished',
      winner: playerIndex === state.lordIndex ? 'lord' : 'peasants',
      moveCount: state.moveCount + 1,
    }
  }

  return {
    ...state,
    hands,
    lastPlay: played,
    currentPlayer: (playerIndex + 1) % 3,
    moveCount: state.moveCount + 1,
  }
}

/** 过牌（不出）。首出或自己领出的回合不能过。 */
export function passTurn(state: DoudizhuState, playerIndex: number): DoudizhuState {
  if (state.phase !== 'playing' || state.currentPlayer !== playerIndex) return state
  if (!state.lastPlay) return state
  const lastPlayer = Number(state.lastPlay.player)
  if (lastPlayer === playerIndex) return state

  const next = (playerIndex + 1) % 3
  // 轮回到上次出牌者：其余两家都过了，清空场面让其自由领出。
  return {
    ...state,
    currentPlayer: next,
    lastPlay: next === lastPlayer ? null : state.lastPlay,
    moveCount: state.moveCount + 1,
  }
}

/** 玩家索引对应的一手牌是否合法且能接上家（供 UI 判断「出牌」按钮是否可用）。 */
export function isLegalPlay(state: DoudizhuState, playerIndex: number, cards: Card[]): boolean {
  if (cards.length === 0) return false
  const mustBeat = state.lastPlay !== null && Number(state.lastPlay.player) !== playerIndex
  return mustBeat ? canPlayHand(cards, state.lastPlay) : identifyHandType(cards) !== null
}
