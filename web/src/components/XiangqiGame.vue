<script setup lang="ts">
// 中国象棋游戏组件
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useRoomStore } from '@/stores/room'
import type { GameTable } from '@/core/games'
import {
  initXiangqi,
  getPiece,
  getXiangqiMoves,
  isValidXiangqiMove,
  applyXiangqiMove,
  createClock,
  tickClockOnMove,
  clockRemaining,
  isTimedOut,
  XIANGQI_ROWS,
  XIANGQI_COLS,
  type XiangqiState,
  type Position,
  type PieceColor,
  type Piece,
} from '@/utils/xiangqi'

const props = defineProps<{ table: GameTable }>()
const store = useRoomStore()

// 初始优先采用 store 中已有的对局状态（中途加入/组件重挂载时不至于回到初盘）。
const existing = store.gameStates.get(props.table.tableId) as XiangqiState | undefined
const gameState = ref<XiangqiState>(
  existing && Array.isArray(existing.board) ? existing : initXiangqi(),
)
const selectedPos = ref<Position | null>(null)
const validMoves = ref<Position[]>([])

// 实时时钟：now 每 250ms 刷新一次，驱动倒计时显示与超时判定。
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

// 消费对端走法：game-move 广播后存入 store.gameStates，这里合并进本地棋局。
// 进度判据：对端 history 更长才采纳；长度相同但状态位变化（超时判负等无落子的终局）也采纳。
// 缺了这个 watch，对手的走子永远不会显示、轮次也不会推进，整局会卡死。
watch(
  () => store.gameStates.get(props.table.tableId) as XiangqiState | undefined,
  (remote) => {
    if (!remote || !Array.isArray(remote.board)) return
    const rl = remote.history?.length ?? 0
    const ll = gameState.value.history.length
    if (rl < ll) return
    if (rl === ll && remote.status === gameState.value.status) return
    gameState.value = remote
    // 对端落子后本地的选择态已失效，清掉高亮。
    selectedPos.value = null
    validMoves.value = []
  },
  { deep: true },
)

const players = computed(() => {
  return [props.table.players[0] || '', props.table.players[1] || '']
})

// 开局协商配置（table.config）。redSeat 决定谁执红/先手。
const cfg = computed(() => (props.table.config as any) || {})
const redSeat = computed<0 | 1>(() => (cfg.value.redSeat === 1 ? 1 : 0))

const mySeat = computed(() => players.value.indexOf(store.myId))

const myColor = computed((): PieceColor | null => {
  const seat = mySeat.value
  if (seat !== 0 && seat !== 1) return null
  return seat === redSeat.value ? 'red' : 'black'
})

// 黑方视角翻转棋盘：让本方棋子始终在下方。旁观者用默认（红在下）朝向。
const flip = computed(() => myColor.value === 'black')

const myTurn = computed(() => {
  return (
    props.table.state === 'playing' &&
    gameState.value.status === 'playing' &&
    gameState.value.turn === myColor.value
  )
})

// —— 开局协商 ——
const isPlayer = computed(() => mySeat.value === 0 || mySeat.value === 1)
const agreed = computed(() => !!cfg.value.agreed)
const pendingProposal = computed(() => cfg.value.proposal || null)
// 待我处理的提议（对方发来、尚未确认）
const proposalForMe = computed(
  () => pendingProposal.value && pendingProposal.value.by !== store.myId,
)

// 协商表单（本地编辑值）
const formRedSeat = ref<0 | 1>(0)
const formGameMin = ref(10)
const formMoveSec = ref(60)

// 表单初值随配置刷新（收到新提议时同步展示，方便直接接受或改动）
watch(
  () => [cfg.value.redSeat, cfg.value.gameTimeSec, cfg.value.moveTimeSec, pendingProposal.value],
  () => {
    const src = pendingProposal.value || cfg.value
    if (src.redSeat === 0 || src.redSeat === 1) formRedSeat.value = src.redSeat
    if (typeof src.gameTimeSec === 'number') formGameMin.value = Math.round(src.gameTimeSec / 60)
    if (typeof src.moveTimeSec === 'number') formMoveSec.value = src.moveTimeSec
  },
  { immediate: true },
)

function sendProposal(): void {
  store.proposeXiangqiConfig(props.table.tableId, {
    redSeat: formRedSeat.value,
    gameTimeSec: Math.max(0, Math.round(formGameMin.value * 60)),
    moveTimeSec: Math.max(0, Math.round(formMoveSec.value)),
  })
}

function acceptProposal(): void {
  store.acceptXiangqiConfig(props.table.tableId)
}

function seatName(seat: number): string {
  return store.displayName(players.value[seat] || '') || `座位 ${seat + 1}`
}

// —— 时钟：开局时按配置生成本地时钟 ——
watch(
  () => props.table.state,
  (s) => {
    if (s !== 'playing') return
    if (gameState.value.clock) return
    if (!agreed.value) return
    const clock = createClock(
      {
        redSeat: redSeat.value,
        gameTimeSec: Number(cfg.value.gameTimeSec) || 0,
        moveTimeSec: Number(cfg.value.moveTimeSec) || 0,
      },
      Date.now(),
    )
    if (clock) gameState.value = { ...gameState.value, clock }
  },
  { immediate: true },
)

const clockOn = computed(() => !!gameState.value.clock)

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function displayClock(color: PieceColor): { move: number; game: number } | null {
  const clock = gameState.value.clock
  if (!clock) return null
  const active = gameState.value.status === 'playing' && gameState.value.turn === color
  const { moveLeft, gameLeft } = clockRemaining(clock, color, active, now.value)
  return { move: moveLeft, game: gameLeft }
}

const CELL_W = 50
const CELL_H = 55
const PAD = 30
const BOARD_W = CELL_W * (XIANGQI_COLS - 1) + PAD * 2
const BOARD_H = CELL_H * (XIANGQI_ROWS - 1) + PAD * 2

// 逻辑坐标 → 屏幕坐标（黑方视角整体旋转 180°）
function dispX(col: number): number {
  const c = flip.value ? XIANGQI_COLS - 1 - col : col
  return PAD + c * CELL_W
}
function dispY(row: number): number {
  const r = flip.value ? XIANGQI_ROWS - 1 - row : row
  return PAD + r * CELL_H
}

const PIECE_NAMES: Record<string, string> = {
  'K-red': '帅',
  'K-black': '将',
  'A-red': '仕',
  'A-black': '士',
  'B-red': '相',
  'B-black': '象',
  'N-red': '马',
  'N-black': '馬',
  'R-red': '车',
  'R-black': '車',
  'C-red': '炮',
  'C-black': '砲',
  'P-red': '兵',
  'P-black': '卒',
}

function getPieceName(piece: Piece): string {
  return PIECE_NAMES[`${piece.type}-${piece.color}`] || ''
}

function clickBoard(row: number, col: number): void {
  if (!myTurn.value) return

  const pos: Position = { row, col }
  const piece = getPiece(gameState.value, pos)

  // 如果已经选中了己方棋子
  if (selectedPos.value) {
    // 点击的是可走的位置
    if (validMoves.value.some((m) => m.row === row && m.col === col)) {
      makeMove(selectedPos.value, pos)
      selectedPos.value = null
      validMoves.value = []
    }
    // 点击的是另一个己方棋子，切换选择
    else if (piece && piece.color === myColor.value) {
      selectedPos.value = pos
      validMoves.value = getXiangqiMoves(gameState.value, pos)
    }
    // 取消选择
    else {
      selectedPos.value = null
      validMoves.value = []
    }
  }
  // 选择己方棋子
  else if (piece && piece.color === myColor.value) {
    selectedPos.value = pos
    validMoves.value = getXiangqiMoves(gameState.value, pos)
  }
}

function makeMove(from: Position, to: Position): void {
  if (!isValidXiangqiMove(gameState.value, { from, to })) return

  let newState = applyXiangqiMove(gameState.value, { from, to })
  // 结算走子方的时钟（消耗步时，溢出扣局时），并为对手重置步时。
  if (newState.clock && myColor.value) {
    newState = { ...newState, clock: tickClockOnMove(newState.clock, myColor.value, Date.now()) }
  }
  gameState.value = newState

  // 广播完整棋局状态（含时钟），对端据 history 长度合并。
  store.sendGameMove(props.table.tableId, newState)
}

// 超时判负：只有当前行棋方在自己本地时钟上判定并广播（无跨端时钟偏差问题）。
function checkTimeout(): void {
  const gs = gameState.value
  if (!gs.clock || gs.status !== 'playing' || !myTurn.value || !myColor.value) return
  if (!isTimedOut(gs.clock, myColor.value, Date.now())) return
  const winner: PieceColor = myColor.value === 'red' ? 'black' : 'red'
  const newState: XiangqiState = { ...gs, status: 'timeout', winner }
  gameState.value = newState
  store.sendGameMove(props.table.tableId, newState)
}

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
    checkTimeout()
  }, 250)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

function isSelected(row: number, col: number): boolean {
  return selectedPos.value?.row === row && selectedPos.value?.col === col
}

function getPlayerName(color: PieceColor): string {
  const seat = color === 'red' ? redSeat.value : redSeat.value === 0 ? 1 : 0
  return store.displayName(players.value[seat] || '')
}

const statusText = computed(() => {
  const gs = gameState.value
  if (gs.status === 'checkmate') {
    return gs.winner === myColor.value ? '🎉 你赢了！' : '😢 你输了！'
  }
  if (gs.status === 'timeout') {
    return gs.winner === myColor.value ? '🎉 对方超时，你赢了！' : '⏰ 超时判负，你输了！'
  }
  if (props.table.state !== 'playing') return ''
  return myTurn.value ? '轮到你走棋' : '等待对手...'
})
</script>

<template>
  <div class="xiangqi-game">
    <!-- 开局协商（等待中，仅玩家可见） -->
    <div v-if="props.table.state === 'waiting' && isPlayer" class="negotiate">
      <h3>开局设置</h3>
      <div v-if="agreed" class="nego-agreed">
        <p>✅ 已确认：{{ seatName(redSeat) }} 执红先手</p>
        <p>
          局时 {{ cfg.gameTimeSec ? Math.round(cfg.gameTimeSec / 60) + ' 分' : '不限' }} ·
          步时 {{ cfg.moveTimeSec ? cfg.moveTimeSec + ' 秒' : '不限' }}
        </p>
        <p class="nego-hint">可再次调整后重新提议；等待桌主开始游戏。</p>
      </div>
      <div v-else-if="proposalForMe" class="nego-incoming">
        <p>📩 对方提议：{{ seatName(pendingProposal.redSeat) }} 执红先手</p>
        <p>
          局时 {{ pendingProposal.gameTimeSec ? Math.round(pendingProposal.gameTimeSec / 60) + ' 分' : '不限' }} ·
          步时 {{ pendingProposal.moveTimeSec ? pendingProposal.moveTimeSec + ' 秒' : '不限' }}
        </p>
        <div class="nego-actions">
          <button class="btn-accept" @click="acceptProposal">接受</button>
          <span class="nego-or">或修改后重新提议 ↓</span>
        </div>
      </div>
      <p v-else-if="pendingProposal" class="nego-hint">已发出提议，等待对方确认…</p>

      <div class="nego-form">
        <label>
          先手（执红）
          <select v-model.number="formRedSeat">
            <option :value="0">{{ seatName(0) }}</option>
            <option :value="1">{{ seatName(1) }}</option>
          </select>
        </label>
        <label>
          局时（分钟，0=不限）
          <input type="number" v-model.number="formGameMin" min="0" max="120" />
        </label>
        <label>
          步时（秒，0=不限）
          <input type="number" v-model.number="formMoveSec" min="0" max="600" />
        </label>
        <button class="btn-propose" @click="sendProposal">发送提议</button>
      </div>
    </div>

    <div class="game-status">
      <div class="players">
        <div class="player" :class="{ active: gameState.turn === 'red' && gameState.status === 'playing' }">
          <span class="piece-label red">红</span>
          <span>{{ getPlayerName('red') }}</span>
          <span v-if="clockOn" class="clock">
            ⏱ {{ fmtTime(displayClock('red')!.game) }}
            <span v-if="cfg.moveTimeSec" class="move-clock">/ {{ fmtTime(displayClock('red')!.move) }}</span>
          </span>
        </div>
        <span class="vs">VS</span>
        <div class="player" :class="{ active: gameState.turn === 'black' && gameState.status === 'playing' }">
          <span class="piece-label black">黑</span>
          <span>{{ getPlayerName('black') }}</span>
          <span v-if="clockOn" class="clock">
            ⏱ {{ fmtTime(displayClock('black')!.game) }}
            <span v-if="cfg.moveTimeSec" class="move-clock">/ {{ fmtTime(displayClock('black')!.move) }}</span>
          </span>
        </div>
      </div>

      <div class="status-text">
        <span>{{ statusText }}</span>
      </div>

      <div class="move-count">第 {{ gameState.history.length }} 回合</div>
    </div>

    <svg
      class="board"
      :viewBox="`0 0 ${BOARD_W} ${BOARD_H}`"
    >
      <!-- 棋盘背景 -->
      <rect x="0" y="0" :width="BOARD_W" :height="BOARD_H" class="board-bg" rx="8" />

      <!-- 网格线 -->
      <g class="grid">
        <!-- 横线 -->
        <line
          v-for="i in XIANGQI_ROWS"
          :key="`h${i}`"
          :x1="PAD"
          :y1="PAD + (i - 1) * CELL_H"
          :x2="BOARD_W - PAD"
          :y2="PAD + (i - 1) * CELL_H"
        />
        <!-- 纵线（楚河汉界断开） -->
        <line
          v-for="i in XIANGQI_COLS"
          :key="`v${i}-1`"
          :x1="PAD + (i - 1) * CELL_W"
          :y1="PAD"
          :x2="PAD + (i - 1) * CELL_W"
          :y2="PAD + 4 * CELL_H"
        />
        <line
          v-for="i in XIANGQI_COLS"
          :key="`v${i}-2`"
          :x1="PAD + (i - 1) * CELL_W"
          :y1="PAD + 5 * CELL_H"
          :x2="PAD + (i - 1) * CELL_W"
          :y2="PAD + 9 * CELL_H"
        />
        <!-- 九宫斜线 -->
        <line :x1="PAD + 3 * CELL_W" :y1="PAD" :x2="PAD + 5 * CELL_W" :y2="PAD + 2 * CELL_H" />
        <line :x1="PAD + 5 * CELL_W" :y1="PAD" :x2="PAD + 3 * CELL_W" :y2="PAD + 2 * CELL_H" />
        <line :x1="PAD + 3 * CELL_W" :y1="PAD + 7 * CELL_H" :x2="PAD + 5 * CELL_W" :y2="PAD + 9 * CELL_H" />
        <line :x1="PAD + 5 * CELL_W" :y1="PAD + 7 * CELL_H" :x2="PAD + 3 * CELL_W" :y2="PAD + 9 * CELL_H" />
      </g>

      <!-- 楚河汉界文字 -->
      <text :x="BOARD_W / 2 - 60" :y="PAD + 4.5 * CELL_H + 8" class="river-text">楚河</text>
      <text :x="BOARD_W / 2 + 20" :y="PAD + 4.5 * CELL_H + 8" class="river-text">汉界</text>

      <!-- 可走位置提示 -->
      <circle
        v-for="(move, i) in validMoves"
        :key="`move${i}`"
        :cx="dispX(move.col)"
        :cy="dispY(move.row)"
        r="8"
        class="valid-move"
      />

      <!-- 棋子（纯展示，不接收点击；命中交给下方透明命中层） -->
      <g class="pieces">
        <template v-for="c in XIANGQI_COLS" :key="`col${c}`">
          <template v-for="r in XIANGQI_ROWS" :key="`${r}-${c}`">
            <circle
              v-if="getPiece(gameState, { row: r - 1, col: c - 1 })"
              :cx="dispX(c - 1)"
              :cy="dispY(r - 1)"
              r="22"
              class="piece-bg"
              :class="{
                red: getPiece(gameState, { row: r - 1, col: c - 1 })?.color === 'red',
                black: getPiece(gameState, { row: r - 1, col: c - 1 })?.color === 'black',
                selected: isSelected(r - 1, c - 1),
              }"
            />
            <text
              v-if="getPiece(gameState, { row: r - 1, col: c - 1 })"
              :x="dispX(c - 1)"
              :y="dispY(r - 1) + 6"
              class="piece-text"
              :class="{
                red: getPiece(gameState, { row: r - 1, col: c - 1 })?.color === 'red',
                black: getPiece(gameState, { row: r - 1, col: c - 1 })?.color === 'black',
              }"
            >
              {{ getPieceName(getPiece(gameState, { row: r - 1, col: c - 1 })!) }}
            </text>
          </template>
        </template>
      </g>

      <!-- 透明命中层：每个交叉点都有一块可点区域，空格落子也能触发 clickBoard。
           必须盖在棋子与提示之上，且覆盖整格，否则点击空目标格无反应。 -->
      <g class="hit-layer" :class="{ clickable: myTurn }">
        <template v-for="c in XIANGQI_COLS" :key="`hit-col${c}`">
          <rect
            v-for="r in XIANGQI_ROWS"
            :key="`hit-${r}-${c}`"
            :x="dispX(c - 1) - CELL_W / 2"
            :y="dispY(r - 1) - CELL_H / 2"
            :width="CELL_W"
            :height="CELL_H"
            class="hit-cell"
            @click="clickBoard(r - 1, c - 1)"
          />
        </template>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.xiangqi-game {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 20px;
  padding: 20px;
}

.game-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  background: var(--panel);
  border-radius: var(--radius);
  min-width: 300px;
}

.players {
  display: flex;
  align-items: center;
  gap: 16px;
}

.player {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  border: 2px solid transparent;
  transition: all 0.2s;
}

.player.active {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.piece-label {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 14px;
  font-weight: 700;
  flex-shrink: 0;
}

.piece-label.red {
  background: #d32f2f;
  color: white;
}

.piece-label.black {
  background: #212121;
  color: white;
}

.vs {
  font-size: 12px;
  color: var(--muted);
}

.status-text {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.move-count {
  font-size: 12px;
  color: var(--muted);
}

.board {
  width: min(90vmin, 500px);
  display: block;
  user-select: none;
}

.board-bg {
  fill: #f4d29f;
}

.grid line {
  stroke: #8b6914;
  stroke-width: 1.5;
}

.river-text {
  fill: #8b6914;
  font-size: 20px;
  font-weight: 700;
  text-anchor: middle;
  opacity: 0.6;
}

.valid-move {
  fill: var(--accent);
  opacity: 0.5;
  pointer-events: none;
}

.piece-bg {
  fill: #f9f3e8;
  stroke-width: 2.5;
  transition: all 0.2s;
}

.pieces {
  pointer-events: none;
}

.hit-cell {
  fill: transparent;
}

.hit-layer.clickable .hit-cell {
  cursor: pointer;
}

.piece-bg.red {
  stroke: #d32f2f;
}

.piece-bg.black {
  stroke: #212121;
}

.piece-bg.selected {
  fill: var(--accent-weak);
  stroke: var(--accent);
  stroke-width: 3;
}

.piece-bg:hover {
  filter: brightness(0.95);
}

.piece-text {
  fill: #d32f2f;
  font-size: 18px;
  font-weight: 700;
  text-anchor: middle;
  pointer-events: none;
}

.piece-text.black {
  fill: #212121;
}

.clickable {
  cursor: pointer;
}

/* 开局协商 */
.negotiate {
  width: min(90vw, 420px);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.negotiate h3 {
  margin: 0;
  font-size: 15px;
  color: var(--text);
}

.negotiate p {
  margin: 0;
  font-size: 13px;
  color: var(--text);
}

.nego-hint {
  color: var(--muted);
  font-size: 12px;
}

.nego-incoming,
.nego-agreed {
  padding: 10px 12px;
  border-radius: var(--radius);
  background: var(--accent-weak);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nego-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}

.nego-or {
  font-size: 12px;
  color: var(--muted);
}

.nego-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.nego-form label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
}

.nego-form select,
.nego-form input {
  width: 140px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}

.btn-propose,
.btn-accept {
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-propose {
  margin-top: 4px;
}

.btn-propose:hover,
.btn-accept:hover {
  background: var(--accent-strong);
}

.clock {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-strong);
  font-variant-numeric: tabular-nums;
}

.move-clock {
  color: var(--muted);
  font-weight: 500;
}
</style>
