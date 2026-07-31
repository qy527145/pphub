<script setup lang="ts">
// 斗地主游戏组件（三人联机）。
// 同步模型：桌主（hostId）在游戏开始时发牌并广播全量状态；此后每次叫分/出牌/过牌
// 都由「当前行动玩家」推进纯函数后广播新状态。各端以 moveCount 单调递增判断新旧，
// 避免旧状态回灌。座位号取 table.players 中的下标，与 DoudizhuState 的 0/1/2 对应。
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useRoomStore } from '@/stores/room'
import type { GameTable } from '@/core/games'
import {
  initDoudizhu,
  sortHand,
  placeBid,
  playCards,
  passTurn,
  isLegalPlay,
  type DoudizhuState,
  type Card,
} from '@/utils/doudizhu'

const props = defineProps<{ table: GameTable }>()
const store = useRoomStore()

function isDoudizhuState(v: unknown): v is DoudizhuState {
  return !!v && Array.isArray((v as DoudizhuState).hands)
}

const existing = store.gameStates.get(props.table.tableId)
const gameState = ref<DoudizhuState | null>(isDoudizhuState(existing) ? existing : null)

// 已选中的牌（key = suit-rank，牌面唯一）
const selectedKeys = ref<Set<string>>(new Set())

function cardKey(c: Card): string {
  return `${c.suit}-${c.rank}`
}

// 我的座位号（0/1/2）；不在玩家席则为 -1（旁观）。
// 座位由本局 gameState.seats 决定（开局随机打乱），未开局时回退到 table.players 顺序。
const mySeat = computed(() => {
  const gs = gameState.value
  if (gs) return gs.seats.indexOf(store.myId)
  return props.table.players.indexOf(store.myId)
})
const isHost = computed(() => props.table.hostId === store.myId)

// 消费对端广播的状态：game-move → store.gameStates → 合并进本地。
// 以 moveCount 为进度判据，仅采纳更靠后的状态。
watch(
  () => store.gameStates.get(props.table.tableId),
  (remote) => {
    if (!isDoudizhuState(remote)) return
    if (gameState.value && remote.moveCount <= gameState.value.moveCount) return
    gameState.value = remote
    selectedKeys.value = new Set()
  },
  { deep: true },
)

// 桌主在开局时发牌（只有一端洗牌，保证各端一致），并广播初始状态。
// 座位随机打乱、叫地主起手随机，均在 initDoudizhu 内完成。
watch(
  () => props.table.state,
  (s) => {
    if (s === 'playing' && isHost.value && !gameState.value) {
      const initial = initDoudizhu(props.table.players)
      gameState.value = initial
      store.sendGameMove(props.table.tableId, initial)
    }
  },
  { immediate: true },
)

const phase = computed(() => gameState.value?.phase ?? null)

const myTurn = computed(() => {
  const gs = gameState.value
  if (!gs || mySeat.value < 0) return false
  if (gs.phase === 'finished') return false
  return gs.currentPlayer === mySeat.value
})

// 我的手牌（按大→小排列，左边大右边小）
const myHand = computed<Card[]>(() => {
  const gs = gameState.value
  if (!gs || mySeat.value < 0) return []
  return sortHand(gs.hands[mySeat.value]).reverse()
})

// 其他两个座位。相对位置固定：上家(我之前出牌者)在左、下家(我之后)在右，
// 保证每个玩家看到的相对布局一致（旁观者按 0/1/2 顺序）。座位 → peerId 用本局 seats。
const opponents = computed(() => {
  const gs = gameState.value
  if (!gs) return []
  const seats =
    mySeat.value < 0
      ? [0, 1, 2]
      : [(mySeat.value + 2) % 3, (mySeat.value + 1) % 3]
  return seats.map((seat, i) => ({
    seat,
    peerId: gs.seats[seat] || '',
    count: gs.hands[seat]?.length ?? 0,
    isLord: gs.lordIndex === seat,
    isTurn: gs.currentPlayer === seat && gs.phase !== 'finished',
    posLabel: mySeat.value < 0 ? '' : i === 0 ? '上家' : '下家',
  }))
})

const selectedCards = computed<Card[]>(() =>
  myHand.value.filter((c) => selectedKeys.value.has(cardKey(c))),
)

const canPlaySelected = computed(() => {
  const gs = gameState.value
  if (!gs || !myTurn.value || gs.phase !== 'playing') return false
  return isLegalPlay(gs, mySeat.value, selectedCards.value)
})

// 首出或自己领出时不能过牌
const canPass = computed(() => {
  const gs = gameState.value
  if (!gs || !myTurn.value || gs.phase !== 'playing') return false
  return gs.lastPlay !== null && Number(gs.lastPlay.player) !== mySeat.value
})

// 拖拽快速连选：按下起始牌确定「选中/取消」模式，拖过的牌沿用同一模式，
// 松开结束。单击（按下即松开且未移动）等价于切换该张牌。
const dragging = ref(false)
const dragSelecting = ref(true)

function setCard(c: Card, select: boolean): void {
  const key = cardKey(c)
  const next = new Set(selectedKeys.value)
  if (select) next.add(key)
  else next.delete(key)
  selectedKeys.value = next
}

function startDrag(c: Card): void {
  if (!myTurn.value || phase.value !== 'playing') return
  dragging.value = true
  dragSelecting.value = !selectedKeys.value.has(cardKey(c))
  setCard(c, dragSelecting.value)
}

function dragOver(c: Card): void {
  if (!dragging.value) return
  setCard(c, dragSelecting.value)
}

function endDrag(): void {
  dragging.value = false
}

onMounted(() => window.addEventListener('mouseup', endDrag))
onUnmounted(() => window.removeEventListener('mouseup', endDrag))

function commit(next: DoudizhuState): void {
  gameState.value = next
  selectedKeys.value = new Set()
  store.sendGameMove(props.table.tableId, next)
}

function bid(score: 0 | 1 | 2 | 3): void {
  const gs = gameState.value
  if (!gs || !myTurn.value || gs.phase !== 'bidding') return
  const next = placeBid(gs, mySeat.value, score)
  if (next === gs) return // 非法操作，原样返回
  commit(next)
}

function play(): void {
  const gs = gameState.value
  if (!gs || !canPlaySelected.value) return
  const next = playCards(gs, mySeat.value, selectedCards.value)
  if (next === gs) return
  commit(next)
}

function pass(): void {
  const gs = gameState.value
  if (!gs || !canPass.value) return
  const next = passTurn(gs, mySeat.value)
  if (next === gs) return
  commit(next)
}

// 再来一局：仅桌主可发起（单端发牌保证各端一致）。以「当前 moveCount+1」为新局起始版本，
// 确保新状态严格更新，各端才会采纳。重新随机座位与叫地主顺序。
function restart(): void {
  const gs = gameState.value
  if (!gs || !isHost.value || gs.phase !== 'finished') return
  if (props.table.players.length < 3) return
  const next = initDoudizhu(props.table.players, gs.moveCount + 1)
  commit(next)
}

// —— 展示辅助 ——
const RANK_LABEL: Record<string, string> = {
  small: '小王',
  big: '大王',
}

function rankLabel(c: Card): string {
  return RANK_LABEL[c.rank] ?? c.rank
}

const SUIT_SYMBOL: Record<string, string> = {
  spade: '♠',
  heart: '♥',
  club: '♣',
  diamond: '♦',
  joker: '',
}

function suitSymbol(c: Card): string {
  return SUIT_SYMBOL[c.suit] ?? ''
}

function isRed(c: Card): boolean {
  return c.suit === 'heart' || c.suit === 'diamond' || (c.suit === 'joker' && c.rank === 'big')
}

function seatName(seat: number): string {
  return store.displayName(gameState.value?.seats[seat] || '')
}

const myIsLord = computed(() => gameState.value?.lordIndex === mySeat.value)

// 底牌：定完地主后公开的 3 张（大→小展示）。叫地主阶段不泄露。
const showBottomCards = computed(() => {
  const gs = gameState.value
  return !!gs && gs.lordIndex !== null && gs.phase !== 'bidding'
})
const bottomCards = computed<Card[]>(() => {
  const gs = gameState.value
  if (!gs) return []
  return sortHand(gs.lordCards).reverse()
})

const resultText = computed(() => {
  const gs = gameState.value
  if (!gs || gs.phase !== 'finished' || !gs.winner) return ''
  const iWon = gs.winner === 'lord' ? myIsLord.value : !myIsLord.value
  return iWon ? '🎉 你赢了！' : '😢 你输了！'
})

function bidLabel(b: number | undefined): string {
  if (b === undefined) return ''
  return b === 0 ? '不叫' : `${b}分`
}
</script>

<template>
  <div class="doudizhu-game">
    <div v-if="!gameState" class="waiting">
      <div class="waiting-icon">🃏</div>
      <p>{{ props.table.state === 'playing' ? '正在发牌...' : '等待游戏开始（需 3 名玩家）' }}</p>
    </div>

    <template v-else>
      <!-- 对手信息 -->
      <div class="opponents">
        <div
          v-for="op in opponents"
          :key="op.seat"
          class="opponent"
          :class="{ active: op.isTurn }"
        >
          <span v-if="op.posLabel" class="op-pos">{{ op.posLabel }}</span>
          <span class="op-name">{{ seatName(op.seat) }}</span>
          <span v-if="op.isLord" class="lord-badge">地主</span>
          <span class="op-cards">🂠 × {{ op.count }}</span>
          <span v-if="gameState.phase === 'bidding'" class="op-bid">
            {{ bidLabel(gameState.bids[op.seat]) }}
          </span>
        </div>
      </div>

      <!-- 底牌（定完地主后公开） -->
      <div v-if="showBottomCards" class="bottom-cards">
        <span class="bottom-label">底牌</span>
        <div class="card-row small">
          <div
            v-for="(c, i) in bottomCards"
            :key="`bc-${i}`"
            class="card mini"
            :class="{ red: isRed(c) }"
          >
            <span class="card-rank">{{ rankLabel(c) }}</span>
            <span class="card-suit">{{ suitSymbol(c) }}</span>
          </div>
        </div>
      </div>

      <!-- 中央状态区 -->
      <div class="table-center">
        <div v-if="gameState.phase === 'finished'" class="result-area">
          <div class="result">{{ resultText }}</div>
          <button v-if="isHost" class="btn-restart" @click="restart">再来一局</button>
          <p v-else class="restart-hint">等待桌主开始下一局…</p>
        </div>
        <template v-else>
          <!-- 上一手牌 -->
          <div v-if="gameState.lastPlay" class="last-play">
            <span class="last-play-label">{{ seatName(Number(gameState.lastPlay.player)) }} 出：</span>
            <div class="card-row small">
              <div
                v-for="(c, i) in gameState.lastPlay.cards"
                :key="`lp-${i}`"
                class="card mini"
                :class="{ red: isRed(c) }"
              >
                <span class="card-rank">{{ rankLabel(c) }}</span>
                <span class="card-suit">{{ suitSymbol(c) }}</span>
              </div>
            </div>
          </div>
          <div v-else class="no-play">
            {{ gameState.phase === 'bidding' ? '叫地主阶段' : '等待出牌' }}
          </div>
        </template>
      </div>

      <!-- 我的手牌区 -->
      <div class="my-area">
        <div class="my-header">
          <span class="my-label">
            {{ seatName(mySeat) }}
            <span v-if="myIsLord" class="lord-badge">地主</span>
            <span v-else-if="gameState.lordIndex !== null" class="peasant-badge">农民</span>
          </span>
          <span class="turn-hint" :class="{ mine: myTurn }">
            <template v-if="gameState.phase === 'finished'">游戏结束</template>
            <template v-else-if="myTurn">轮到你了</template>
            <template v-else>等待其他玩家...</template>
          </span>
        </div>

        <div v-if="mySeat < 0" class="spectator-note">你正在旁观本局</div>
        <div v-else class="card-row hand">
          <div
            v-for="c in myHand"
            :key="cardKey(c)"
            class="card"
            :class="{ red: isRed(c), selected: selectedKeys.has(cardKey(c)), clickable: myTurn && phase === 'playing' }"
            @mousedown.prevent="startDrag(c)"
            @mouseenter="dragOver(c)"
          >
            <span class="card-rank">{{ rankLabel(c) }}</span>
            <span class="card-suit">{{ suitSymbol(c) }}</span>
          </div>
        </div>

        <!-- 操作区 -->
        <div v-if="mySeat >= 0 && myTurn" class="actions">
          <!-- 叫地主 -->
          <template v-if="gameState.phase === 'bidding'">
            <button class="btn-bid" @click="bid(0)">不叫</button>
            <button class="btn-bid" @click="bid(1)">1 分</button>
            <button class="btn-bid" @click="bid(2)">2 分</button>
            <button class="btn-bid primary" @click="bid(3)">3 分</button>
          </template>
          <!-- 出牌 -->
          <template v-else-if="gameState.phase === 'playing'">
            <button class="btn-action" :disabled="!canPass" @click="pass">不出</button>
            <button class="btn-action primary" :disabled="!canPlaySelected" @click="play">出牌</button>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.doudizhu-game {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  gap: 12px;
}

.waiting {
  flex: 1;
  display: grid;
  place-items: center;
  text-align: center;
  color: var(--muted);
}

.waiting-icon {
  font-size: 56px;
  margin-bottom: 12px;
}

.opponents {
  display: flex;
  justify-content: space-around;
  gap: 12px;
}

.opponent {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--panel);
  border-radius: var(--radius);
  border: 2px solid transparent;
  transition: all 0.2s;
}

.opponent.active {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.op-name {
  font-weight: 600;
  color: var(--text);
  font-size: 14px;
}

.op-pos {
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  background: var(--muted-weak);
  color: var(--muted);
}

.bottom-cards {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.bottom-label {
  font-size: 12px;
  color: var(--muted);
}

.op-cards {
  font-size: 13px;
  color: var(--muted);
}

.op-bid {
  font-size: 12px;
  color: var(--accent-strong);
}

.lord-badge,
.peasant-badge {
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 600;
}

.lord-badge {
  background: #d32f2f;
  color: white;
}

.peasant-badge {
  background: var(--muted-weak);
  color: var(--text);
}

.table-center {
  flex: 1;
  display: grid;
  place-items: center;
  min-height: 120px;
}

.result {
  font-size: 28px;
  font-weight: 700;
  color: var(--accent-strong);
}

.result-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.btn-restart {
  padding: 10px 28px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: white;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-restart:hover {
  background: var(--accent-strong);
  transform: translateY(-1px);
}

.restart-hint {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

.last-play {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.last-play-label {
  font-size: 13px;
  color: var(--muted);
}

.no-play {
  font-size: 15px;
  color: var(--muted);
}

.card-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
}

.card-row.hand {
  padding: 8px 0;
  min-height: 90px;
  user-select: none;
}

.card {
  width: 48px;
  height: 68px;
  background: white;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding-top: 4px;
  color: #1f2937;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  margin-left: -14px;
  transition: transform 0.12s, box-shadow 0.12s;
}

.card:first-child {
  margin-left: 0;
}

.card.mini {
  width: 40px;
  height: 56px;
  margin-left: -10px;
}

.card.red {
  color: #d32f2f;
}

.card.clickable {
  cursor: pointer;
}

.card.clickable:hover {
  transform: translateY(-8px);
}

.card.selected {
  transform: translateY(-16px);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
  border-color: var(--accent);
}

.card-rank {
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
}

.card.mini .card-rank {
  font-size: 13px;
}

.card-suit {
  font-size: 15px;
  line-height: 1.1;
}

.my-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--panel);
  border-radius: var(--radius);
}

.my-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.my-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--text);
}

.turn-hint {
  font-size: 13px;
  color: var(--muted);
}

.turn-hint.mine {
  color: var(--accent);
  font-weight: 600;
}

.spectator-note {
  text-align: center;
  padding: 20px;
  color: var(--muted);
}

.actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  padding-top: 4px;
}

.btn-bid,
.btn-action {
  padding: 8px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-bid:hover:not(:disabled),
.btn-action:hover:not(:disabled) {
  background: var(--hover);
}

.btn-bid.primary,
.btn-action.primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.btn-bid.primary:hover:not(:disabled),
.btn-action.primary:hover:not(:disabled) {
  background: var(--accent-strong);
}

.btn-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
