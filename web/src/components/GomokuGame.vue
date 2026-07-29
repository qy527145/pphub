<script setup lang="ts">
// 五子棋游戏组件 - 用于新游戏桌系统
import { computed, ref } from 'vue'
import { useRoomStore } from '@/stores/room'
import type { GameTable } from '@/core/games'
import { GOMOKU_SIZE, gomokuWinLine } from '@/utils/gomoku'

const props = defineProps<{ table: GameTable }>()
const store = useRoomStore()

interface GomokuGameState {
  cells: number[]
  turn: 1 | 2 // 1=黑 2=白
  players: [string, string] // [黑方peerId, 白方peerId]
  moves: number
  lastMove?: number
  winLine?: number[]
  winner?: string
}

const gameState = ref<GomokuGameState>({
  cells: Array(GOMOKU_SIZE * GOMOKU_SIZE).fill(0),
  turn: 1,
  players: [props.table.players[0] || '', props.table.players[1] || ''],
  moves: 0,
})

const myColor = computed(() => {
  const idx = gameState.value.players.indexOf(store.myId)
  return idx === 0 ? 1 : idx === 1 ? 2 : null
})

const myTurn = computed(() => {
  return !gameState.value.winner && gameState.value.turn === myColor.value
})

const CELL = 32
const PAD = CELL
const SIZE = CELL * (GOMOKU_SIZE - 1) + PAD * 2

const STARS = [3, 7, 11].flatMap((y) => [3, 7, 11].map((x) => ({ x, y })))

const stones = computed(() => {
  const out: { idx: number; x: number; y: number; color: number }[] = []
  for (let i = 0; i < gameState.value.cells.length; i++) {
    if (gameState.value.cells[i] !== 0) {
      out.push({
        idx: i,
        x: i % GOMOKU_SIZE,
        y: Math.floor(i / GOMOKU_SIZE),
        color: gameState.value.cells[i],
      })
    }
  }
  return out
})

const winSet = computed(() => new Set(gameState.value.winLine ?? []))

function clickBoard(ev: MouseEvent): void {
  if (!myTurn.value) return

  const svg = ev.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  const lx = ((ev.clientX - rect.left) / rect.width) * SIZE
  const ly = ((ev.clientY - rect.top) / rect.height) * SIZE
  const gx = Math.round((lx - PAD) / CELL)
  const gy = Math.round((ly - PAD) / CELL)

  if (gx < 0 || gx >= GOMOKU_SIZE || gy < 0 || gy >= GOMOKU_SIZE) return

  const idx = gy * GOMOKU_SIZE + gx
  if (gameState.value.cells[idx] !== 0) return

  makeMove(idx)
}

function makeMove(idx: number): void {
  const newCells = [...gameState.value.cells]
  newCells[idx] = gameState.value.turn

  // 检查是否获胜
  const winLine = gomokuWinLine(newCells, idx)

  gameState.value = {
    ...gameState.value,
    cells: newCells,
    lastMove: idx,
    moves: gameState.value.moves + 1,
    winLine: winLine || undefined,
    winner: winLine ? store.myId : undefined,
    turn: gameState.value.turn === 1 ? 2 : 1,
  }

  // 广播走法
  store.sendGameMove(props.table.tableId, {
    idx,
    cells: newCells,
    turn: gameState.value.turn,
    moves: gameState.value.moves,
    winLine,
  })
}

function getPlayerName(playerIdx: 0 | 1): string {
  const peerId = gameState.value.players[playerIdx]
  return store.displayName(peerId)
}
</script>

<template>
  <div class="gomoku-game">
    <div class="game-status">
      <div class="players">
        <div class="player" :class="{ active: gameState.turn === 1 }">
          <div class="stone black"></div>
          <span>{{ getPlayerName(0) }}</span>
        </div>
        <span class="vs">VS</span>
        <div class="player" :class="{ active: gameState.turn === 2 }">
          <div class="stone white"></div>
          <span>{{ getPlayerName(1) }}</span>
        </div>
      </div>

      <div class="status-text">
        <span v-if="gameState.winner">
          {{ gameState.winner === store.myId ? '🎉 你赢了！' : `${store.displayName(gameState.winner)} 获胜！` }}
        </span>
        <span v-else-if="myTurn">轮到你落子</span>
        <span v-else>等待对手...</span>
      </div>

      <div class="move-count">第 {{ gameState.moves }} 手</div>
    </div>

    <svg
      class="board"
      :viewBox="`0 0 ${SIZE} ${SIZE}`"
      :class="{ clickable: myTurn }"
      @click="clickBoard"
    >
      <rect x="0" y="0" :width="SIZE" :height="SIZE" class="wood" rx="10" />
      <g class="grid">
        <line
          v-for="i in GOMOKU_SIZE"
          :key="`h${i}`"
          :x1="PAD"
          :y1="PAD + (i - 1) * CELL"
          :x2="SIZE - PAD"
          :y2="PAD + (i - 1) * CELL"
        />
        <line
          v-for="i in GOMOKU_SIZE"
          :key="`v${i}`"
          :x1="PAD + (i - 1) * CELL"
          :y1="PAD"
          :x2="PAD + (i - 1) * CELL"
          :y2="SIZE - PAD"
        />
      </g>
      <circle
        v-for="(s, i) in STARS"
        :key="`star${i}`"
        :cx="PAD + s.x * CELL"
        :cy="PAD + s.y * CELL"
        r="3"
        class="star"
      />
      <g>
        <circle
          v-for="s in stones"
          :key="s.idx"
          :cx="PAD + s.x * CELL"
          :cy="PAD + s.y * CELL"
          :r="CELL * 0.42"
          class="piece"
          :class="[s.color === 1 ? 'p-black' : 'p-white', { win: winSet.has(s.idx) }]"
        />
        <circle
          v-if="gameState.lastMove !== undefined"
          :cx="PAD + (gameState.lastMove % GOMOKU_SIZE) * CELL"
          :cy="PAD + Math.floor(gameState.lastMove / GOMOKU_SIZE) * CELL"
          r="5"
          class="lastdot"
        />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.gomoku-game {
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

.stone {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  flex-shrink: 0;
}

.stone.black {
  background: #262626;
  border: 1px solid #000;
}

.stone.white {
  background: #fafafa;
  border: 1px solid #999;
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
  width: min(90vmin, 600px);
  aspect-ratio: 1;
  display: block;
  user-select: none;
}

.board.clickable {
  cursor: crosshair;
}

.wood {
  fill: #e8c88f;
}

.grid line {
  stroke: #8a6b3d;
  stroke-width: 1;
}

.star {
  fill: #8a6b3d;
}

.piece.p-black {
  fill: #1d1d1f;
  stroke: #000;
  stroke-width: 1;
}

.piece.p-white {
  fill: #fdfdfd;
  stroke: #9a9a9a;
  stroke-width: 1;
}

.piece.win {
  stroke: var(--danger);
  stroke-width: 3;
}

.lastdot {
  fill: var(--danger);
  pointer-events: none;
}
</style>
