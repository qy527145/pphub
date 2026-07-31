<script setup lang="ts">
// 中国象棋游戏组件
import { computed, ref, watch } from 'vue'
import { useRoomStore } from '@/stores/room'
import type { GameTable } from '@/core/games'
import {
  initXiangqi,
  getPiece,
  getXiangqiMoves,
  isValidXiangqiMove,
  applyXiangqiMove,
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

// 消费对端走法：game-move 广播后存入 store.gameStates，这里合并进本地棋局。
// 以 history.length 作为进度判据（对端更靠后才采纳），避免旧状态回灌。
// 缺了这个 watch，对手的走子永远不会显示、轮次也不会推进，整局会卡死。
watch(
  () => store.gameStates.get(props.table.tableId) as XiangqiState | undefined,
  (remote) => {
    if (!remote || !Array.isArray(remote.board)) return
    if ((remote.history?.length ?? 0) <= gameState.value.history.length) return
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

const myColor = computed((): PieceColor | null => {
  const idx = players.value.indexOf(store.myId)
  return idx === 0 ? 'red' : idx === 1 ? 'black' : null
})

const myTurn = computed(() => {
  return (
    props.table.state === 'playing' &&
    gameState.value.status === 'playing' &&
    gameState.value.turn === myColor.value
  )
})

const CELL_W = 50
const CELL_H = 55
const PAD = 30
const BOARD_W = CELL_W * (XIANGQI_COLS - 1) + PAD * 2
const BOARD_H = CELL_H * (XIANGQI_ROWS - 1) + PAD * 2

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

  const newState = applyXiangqiMove(gameState.value, { from, to })
  gameState.value = newState

  // 广播走法
  store.sendGameMove(props.table.tableId, {
    from,
    to,
    state: newState,
  })
}

function isSelected(row: number, col: number): boolean {
  return selectedPos.value?.row === row && selectedPos.value?.col === col
}

function getPlayerName(color: PieceColor): string {
  const idx = color === 'red' ? 0 : 1
  return store.displayName(players.value[idx])
}
</script>

<template>
  <div class="xiangqi-game">
    <div class="game-status">
      <div class="players">
        <div class="player" :class="{ active: gameState.turn === 'red' }">
          <span class="piece-label red">红</span>
          <span>{{ getPlayerName('red') }}</span>
        </div>
        <span class="vs">VS</span>
        <div class="player" :class="{ active: gameState.turn === 'black' }">
          <span class="piece-label black">黑</span>
          <span>{{ getPlayerName('black') }}</span>
        </div>
      </div>

      <div class="status-text">
        <span v-if="gameState.status === 'checkmate'">
          {{ gameState.winner === myColor ? '🎉 你赢了！' : '😢 你输了！' }}
        </span>
        <span v-else-if="myTurn">轮到你走棋</span>
        <span v-else>等待对手...</span>
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
        :cx="PAD + move.col * CELL_W"
        :cy="PAD + move.row * CELL_H"
        r="8"
        class="valid-move"
      />

      <!-- 棋子（纯展示，不接收点击；命中交给下方透明命中层） -->
      <g class="pieces">
        <template v-for="c in XIANGQI_COLS" :key="`col${c}`">
          <template v-for="r in XIANGQI_ROWS" :key="`${r}-${c}`">
            <circle
              v-if="getPiece(gameState, { row: r - 1, col: c - 1 })"
              :cx="PAD + (c - 1) * CELL_W"
              :cy="PAD + (r - 1) * CELL_H"
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
              :x="PAD + (c - 1) * CELL_W"
              :y="PAD + (r - 1) * CELL_H + 6"
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
            :x="PAD + (c - 1) * CELL_W - CELL_W / 2"
            :y="PAD + (r - 1) * CELL_H - CELL_H / 2"
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
</style>
