<script setup lang="ts">
// 有毒的巧克力（Chomp）游戏组件 - 单机对战 AI
import { computed, onMounted, ref } from 'vue'
import type { GameTable } from '@/core/games'
import {
  initChomp,
  applyChompMove,
  isChompGameOver,
  findBestChompMove,
  clearChompCache,
  boundaryToGrid,
  type ChompState,
  type ChompMove,
} from '@/utils/chomp'

const props = defineProps<{ table: GameTable }>()

interface ChompGameState extends ChompState {
  currentPlayer: 'human' | 'ai'
  winner: 'human' | 'ai' | null
  moveHistory: ChompMove[]
}

const gameState = ref<ChompGameState | null>(null)
const rows = ref(5)
const cols = ref(7)
const configuring = ref(true)

// 初始化游戏
function startGame() {
  clearChompCache()
  const state = initChomp(rows.value, cols.value)
  gameState.value = {
    ...state,
    currentPlayer: 'human',
    winner: null,
    moveHistory: [],
  }
  configuring.value = false
}

// 人类玩家走步
function makeMove(row: number, col: number) {
  if (!gameState.value || gameState.value.currentPlayer !== 'human' || gameState.value.winner) {
    return
  }

  const move: ChompMove = { row, col }
  const newState = applyChompMove(gameState.value, move)

  gameState.value = {
    ...newState,
    currentPlayer: 'ai',
    winner: gameState.value.winner,
    moveHistory: [...gameState.value.moveHistory, move],
  }

  // 检查人类是否输了（吃掉了有毒的巧克力）
  if (isChompGameOver(newState)) {
    gameState.value.winner = 'ai'
    gameState.value.currentPlayer = 'human'
    return
  }

  // AI 走步
  setTimeout(() => {
    aiMove()
  }, 500)
}

// AI 走步
function aiMove() {
  if (!gameState.value || gameState.value.currentPlayer !== 'ai' || gameState.value.winner) {
    return
  }

  const bestMove = findBestChompMove(gameState.value)
  if (!bestMove) return

  const newState = applyChompMove(gameState.value, bestMove)

  gameState.value = {
    ...newState,
    currentPlayer: 'human',
    winner: gameState.value.winner,
    moveHistory: [...gameState.value.moveHistory, bestMove],
  }

  // 检查 AI 是否输了（理论上不会发生，因为 AI 用最佳策略）
  if (isChompGameOver(newState)) {
    gameState.value.winner = 'human'
  }
}

// 重新开始
function restart() {
  configuring.value = true
  gameState.value = null
}

// 获取巧克力块的状态（使用边界转网格）
const gridState = computed(() => {
  if (!gameState.value) return []
  return boundaryToGrid(gameState.value)
})

function getBlockState(row: number, col: number): 'available' | 'eaten' | 'poison' {
  if (!gameState.value) return 'eaten'
  const idx = row * gameState.value.cols + col
  if (!gridState.value[idx]) return 'eaten'
  // 左下角是有毒的
  if (row === gameState.value.rows - 1 && col === 0) return 'poison'
  return 'available'
}

// 检查是否可以点击
function canClick(row: number, col: number): boolean {
  if (!gameState.value || gameState.value.currentPlayer !== 'human' || gameState.value.winner) {
    return false
  }
  return getBlockState(row, col) === 'available' || getBlockState(row, col) === 'poison'
}

const cellSize = computed(() => {
  const maxSize = 60
  const minSize = 30
  const size = Math.min(maxSize, Math.max(minSize, 400 / Math.max(rows.value, cols.value)))
  return size
})

onMounted(() => {
  // 如果已经有配置，直接开始
  if (props.table.config?.rows && props.table.config?.cols) {
    rows.value = props.table.config.rows as number
    cols.value = props.table.config.cols as number
    startGame()
  }
})
</script>

<template>
  <div class="chomp-game">
    <!-- 配置界面 -->
    <div v-if="configuring" class="config-panel">
      <h3>🍫 有毒的巧克力</h3>
      <p class="game-desc">
        轮流吃巧克力，从选中的格子到右上角全部被吃掉。<br />
        吃到左下角有毒的巧克力（💀）就输了！<br />
        AI 使用最佳策略，挑战一下吧！
      </p>

      <div class="config-row">
        <label>行数 (高度):</label>
        <input v-model.number="rows" type="number" min="3" max="10" />
      </div>

      <div class="config-row">
        <label>列数 (宽度):</label>
        <input v-model.number="cols" type="number" min="3" max="12" />
      </div>

      <button class="btn-start-chomp" @click="startGame">开始游戏</button>
    </div>

    <!-- 游戏界面 -->
    <div v-else class="game-panel">
      <div class="game-header">
        <div class="turn-indicator">
          <span v-if="!gameState?.winner">
            {{ gameState?.currentPlayer === 'human' ? '你的回合' : 'AI 思考中...' }}
          </span>
          <span v-else class="result">
            {{ gameState.winner === 'human' ? '🎉 你赢了！' : '😢 你输了！' }}
          </span>
        </div>
        <button class="btn-restart" @click="restart">重新配置</button>
      </div>

      <div class="chocolate-board">
        <div
          class="board-grid"
          :style="{
            gridTemplateColumns: `repeat(${gameState?.cols}, ${cellSize}px)`,
            gridTemplateRows: `repeat(${gameState?.rows}, ${cellSize}px)`,
          }"
        >
          <div
            v-for="row in gameState?.rows"
            :key="`row-${row}`"
            style="display: contents"
          >
            <div
              v-for="col in gameState?.cols"
              :key="`${row}-${col}`"
              class="chocolate-block"
              :class="{
                available: getBlockState(row - 1, col - 1) === 'available',
                eaten: getBlockState(row - 1, col - 1) === 'eaten',
                poison: getBlockState(row - 1, col - 1) === 'poison',
                clickable: canClick(row - 1, col - 1),
              }"
              :style="{ width: `${cellSize}px`, height: `${cellSize}px` }"
              @click="makeMove(row - 1, col - 1)"
            >
              <span v-if="getBlockState(row - 1, col - 1) === 'poison'">💀</span>
            </div>
          </div>
        </div>
      </div>

      <div class="game-stats">
        <div class="stat">
          <span class="stat-label">已走步数:</span>
          <span class="stat-value">{{ gameState?.moveHistory.length || 0 }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">剩余格子:</span>
          <span class="stat-value">{{ gridState.filter(v => v).length || 0 }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chomp-game {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 20px;
}

.config-panel,
.game-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 600px;
}

.config-panel {
  align-items: center;
  text-align: center;
}

.config-panel h3 {
  margin: 0;
  font-size: 28px;
  color: var(--text);
}

.game-desc {
  margin: 0;
  font-size: 14px;
  color: var(--muted);
  line-height: 1.6;
}

.config-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 300px;
}

.config-row label {
  flex: 1;
  text-align: right;
  font-size: 14px;
  color: var(--text);
}

.config-row input {
  width: 80px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
}

.btn-start-chomp,
.btn-restart {
  padding: 10px 24px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-start-chomp:hover,
.btn-restart:hover {
  background: var(--accent-strong);
}

.game-panel {
  align-items: center;
}

.game-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 20px;
  background: var(--panel);
  border-radius: var(--radius);
}

.turn-indicator {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}

.result {
  font-size: 18px;
}

.chocolate-board {
  padding: 20px;
  background: var(--panel);
  border-radius: var(--radius);
}

.board-grid {
  display: grid;
  gap: 4px;
}

.chocolate-block {
  display: grid;
  place-items: center;
  border-radius: 4px;
  transition: all 0.2s;
  font-size: 24px;
  user-select: none;
}

.chocolate-block.available {
  background: #8b4513;
  border: 2px solid #654321;
}

.chocolate-block.poison {
  background: #2d1f0f;
  border: 2px solid #ff0000;
}

.chocolate-block.eaten {
  background: var(--bg);
  border: 1px dashed var(--border);
  opacity: 0.3;
}

.chocolate-block.clickable {
  cursor: pointer;
}

.chocolate-block.clickable:hover {
  transform: scale(1.1);
  box-shadow: 0 4px 12px rgba(139, 69, 19, 0.4);
}

.game-stats {
  display: flex;
  gap: 20px;
  padding: 12px 20px;
  background: var(--panel);
  border-radius: var(--radius);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
}

.stat-label {
  font-size: 12px;
  color: var(--muted);
}

.stat-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--accent-strong);
}
</style>
