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
  /** 三个玩家的手牌 */
  hands: [Card[], Card[], Card[]]
  /** 底牌（3张） */
  lordCards: Card[]
  /** 地主索引（0/1/2） */
  lordIndex: number | null
  /** 当前回合玩家索引 */
  currentPlayer: number
  /** 最后出的牌 */
  lastPlay: PlayedHand | null
  /** 游戏阶段 */
  phase: 'bidding' | 'playing' | 'finished'
  /** 当前叫地主轮次 */
  bids: (0 | 1 | 2 | 3)[]  // 0=不叫，1-3=叫地主（分数）
  /** 游戏结果 */
  winner?: 'lord' | 'peasants'
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

/** 洗牌 */
export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/** 初始化斗地主游戏 */
export function initDoudizhu(): DoudizhuState {
  const deck = shuffleDeck(createDeck())

  return {
    hands: [
      deck.slice(0, 17),
      deck.slice(17, 34),
      deck.slice(34, 51),
    ],
    lordCards: deck.slice(51, 54),
    lordIndex: null,
    currentPlayer: 0,
    lastPlay: null,
    phase: 'bidding',
    bids: [],
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
