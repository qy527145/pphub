<script setup lang="ts">
// 五子棋游戏组件 - 用于新游戏桌系统
import { computed, ref, watch } from 'vue'
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

// 初始状态：若桌上已有同步棋局（旁观者入场 / 离席者回座），直接从中恢复棋盘，
// 否则开一副空盘。座位→执子颜色一律以 seatPlayers 为准，不依赖此处 players。
const existing = store.gameStates.get(props.table.tableId) as
  | { cells?: number[]; turn?: 1 | 2; moves?: number; idx?: number; winLine?: number[]; winner?: string }
  | undefined

const gameState = ref<GomokuGameState>(
  existing && existing.cells
    ? {
        cells: existing.cells,
        turn: existing.turn ?? 1,
        players: [props.table.players[0] || '', props.table.players[1] || ''],
        moves: existing.moves ?? 0,
        lastMove: existing.idx,
        winLine: existing.winLine,
        winner: existing.winner,
      }
    : {
        cells: Array(GOMOKU_SIZE * GOMOKU_SIZE).fill(0),
        turn: 1,
        players: [props.table.players[0] || '', props.table.players[1] || ''],
        moves: 0,
      },
)

// 座位表：优先用开局冻结的 roster（对局中有人离席回座也不会错位），否则回退当前 players。
const seatPlayers = computed<[string, string]>(() => {
  const r =
    props.table.roster && props.table.roster.length >= 2 ? props.table.roster : props.table.players
  return [r[0] || '', r[1] || '']
})

// 监听远程走法
watch(() => store.gameStates.get(props.table.tableId), (remoteState) => {
  if (remoteState && remoteState.moves > gameState.value.moves) {
    console.log('[Gomoku] 收到远程走法:', remoteState)
    gameState.value = {
      ...gameState.value,
      cells: remoteState.cells || gameState.value.cells,
      turn: remoteState.turn || gameState.value.turn,
      moves: remoteState.moves || gameState.value.moves,
      lastMove: remoteState.idx,
      winLine: remoteState.winLine,
      winner: remoteState.winner,
    }
  }
}, { deep: true })

// 监听桌子状态变化，游戏开始时初始化玩家
watch(() => props.table.state, (newState) => {
  if (newState === 'playing' && props.table.players.length >= 2) {
    gameState.value.players = [props.table.players[0], props.table.players[1]]
    console.log('[Gomoku] 游戏开始，玩家:', gameState.value.players)
  }
})

const myColor = computed(() => {
  const idx = seatPlayers.value.indexOf(store.myId)
  return idx === 0 ? 1 : idx === 1 ? 2 : null
})

const myTurn = computed(() => {
  if (!myColor.value || gameState.value.winner || props.table.state !== 'playing') return false
  return gameState.value.turn === myColor.value
})

const SIZE = 600
const PAD = 20
const CELL = (SIZE - PAD * 2) / (GOMOKU_SIZE - 1)

const pieces = computed(() => {
  const out = []
  for (let i = 0; i < gameState.value.cells.length; i++) {
    if (gameState.value.cells[i]) {
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
    winner: winLine ? store.myId : undefined,
  })
}

function getPlayerName(playerIdx: 0 | 1): string {
  const peerId = seatPlayers.value[playerIdx]
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

      <div v-if="gameState.winner" class="result">
        {{ gameState.winner === store.myId ? '你赢了！' : `${store.displayName(gameState.winner)} 赢了！` }}
      </div>
      <div v-else-if="props.table.state !== 'playing'" class="waiting">
        等待游戏开始...
      </div>
      <div v-else-if="myTurn" class="turn-hint">
        轮到你了
      </div>
      <div v-else class="turn-hint">
        等待对手...
      </div>
    </div>

    <svg
      :width="SIZE"
      :height="SIZE"
      class="board"
      :class="{ clickable: myTurn }"
      @click="clickBoard"
    >
      <!-- 棋盘线 -->
      <line
        v-for="i in GOMOKU_SIZE"
        :key="`h${i}`"
        :x1="PAD"
        :y1="PAD + (i - 1) * CELL"
        :x2="PAD + (GOMOKU_SIZE - 1) * CELL"
        :y2="PAD + (i - 1) * CELL"
        stroke="var(--border)"
        stroke-width="1"
      />
      <line
        v-for="i in GOMOKU_SIZE"
        :key="`v${i}`"
        :x1="PAD + (i - 1) * CELL"
        :y1="PAD"
        :x2="PAD + (i - 1) * CELL"
        :y2="PAD + (GOMOKU_SIZE - 1) * CELL"
        stroke="var(--border)"
        stroke-width="1"
      />

      <!-- 星位 -->
      <circle
        v-for="([x, y], i) in [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]]"
        :key="`star${i}`"
        :cx="PAD + x * CELL"
        :cy="PAD + y * CELL"
        r="4"
        fill="var(--border)"
      />

      <!-- 棋子 -->
      <g v-for="p in pieces" :key="p.idx">
        <circle
          :cx="PAD + p.x * CELL"
          :cy="PAD + p.y * CELL"
          :r="CELL * 0.45"
          :class="['stone-svg', p.color === 1 ? 'black' : 'white', { win: winSet.has(p.idx) }]"
        />
        <circle
          v-if="p.idx === gameState.lastMove"
          :cx="PAD + p.x * CELL"
          :cy="PAD + p.y * CELL"
          r="6"
          :fill="p.color === 1 ? 'white' : 'black'"
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
  gap: 20px;
  padding: 20px;
}

.game-status {
  text-align: center;
}

.players {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 12px;
}

.player {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: var(--radius);
  background: var(--bg);
  opacity: 0.5;
  transition: opacity 0.3s;
}

.player.active {
  opacity: 1;
  background: var(--accent-weak);
}

.stone {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--border);
}

.stone.black {
  background: #000;
}

.stone.white {
  background: #fff;
}

.vs {
  font-weight: 600;
  color: var(--muted);
}

.result {
  font-size: 20px;
  font-weight: 600;
  color: var(--success);
}

.waiting {
  font-size: 16px;
  color: var(--muted);
}

.turn-hint {
  font-size: 16px;
  color: var(--accent);
  font-weight: 600;
}

.board {
  background: #dcb35c;
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
}

.board.clickable {
  cursor: crosshair;
}

.stone-svg {
  stroke: var(--border);
  stroke-width: 1;
  transition: all 0.2s;
}

.stone-svg.black {
  fill: #000;
}

.stone-svg.white {
  fill: #fff;
}

.stone-svg.win {
  stroke: var(--success);
  stroke-width: 3;
}
</style>
