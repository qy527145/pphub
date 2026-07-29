<script setup lang="ts">
// 游戏大厅 - 展示所有游戏，可以创建/加入游戏桌
import { computed, ref } from 'vue'
import { useRoomStore } from '@/stores/room'
import { GAME_CATALOG, type GameType, type GameCategory, type GameTable } from '@/core/games'
import PeerAvatar from './PeerAvatar.vue'
import GameTableView from './GameTable.vue'

const store = useRoomStore()

// 如果用户已在游戏桌中，显示游戏桌界面
const inGameTable = computed(() => !!store.currentTableId)

const selectedCategory = ref<GameCategory | 'all'>('all')

const filteredGames = computed(() => {
  if (selectedCategory.value === 'all') return GAME_CATALOG
  return GAME_CATALOG.filter(g => g.category === selectedCategory.value)
})

/** 所有公开的游戏桌 */
const publicTables = computed(() => {
  return Array.from(store.gameTables.values()).filter(t => t.visibility === 'public')
})

/** 按游戏类型分组的游戏桌 */
const tablesByGame = computed(() => {
  const map = new Map<GameType, GameTable[]>()
  for (const table of publicTables.value) {
    const list = map.get(table.gameType) || []
    list.push(table)
    map.set(table.gameType, list)
  }
  return map
})

function createTable(gameType: GameType, isPublic: boolean): void {
  store.createGameTable(gameType, isPublic)
}

function joinTable(tableId: string): void {
  store.joinGameTable(tableId, false)
}

function spectateTable(tableId: string): void {
  store.joinGameTable(tableId, true)
}

function getTableStateText(table: GameTable): string {
  const playerCount = table.players.length
  const spectatorCount = table.spectators.length

  if (table.state === 'waiting') {
    return `等待中 (${playerCount}人)`
  } else if (table.state === 'playing') {
    return `游戏中 (${playerCount}人${spectatorCount > 0 ? `, ${spectatorCount}人观战` : ''})`
  } else {
    return '已结束'
  }
}

function getPlayerNick(peerId: string): string {
  return store.displayName(peerId)
}
</script>

<template>
  <!-- 如果已在游戏桌中，显示游戏桌界面 -->
  <GameTableView v-if="inGameTable" />

  <!-- 否则显示游戏大厅 -->
  <div v-else class="lobby">
    <header class="lobby-header">
      <h2>🎮 游戏大厅</h2>
      <div class="category-tabs">
        <button
          :class="{ active: selectedCategory === 'all' }"
          @click="selectedCategory = 'all'"
        >
          全部
        </button>
        <button
          :class="{ active: selectedCategory === 'single' }"
          @click="selectedCategory = 'single'"
        >
          单机游戏
        </button>
        <button
          :class="{ active: selectedCategory === 'double' }"
          @click="selectedCategory = 'double'"
        >
          双人游戏
        </button>
        <button
          :class="{ active: selectedCategory === 'multi' }"
          @click="selectedCategory = 'multi'"
        >
          多人游戏
        </button>
      </div>
    </header>

    <div class="lobby-content">
      <div class="games-grid">
        <div v-for="game in filteredGames" :key="game.id" class="game-card">
          <div class="game-icon">{{ game.icon }}</div>
          <h3 class="game-name">{{ game.name }}</h3>
          <p class="game-desc">{{ game.description }}</p>
          <div class="game-info">
            <span class="player-count">{{ game.playerCount }}人</span>
            <span v-if="game.spectatable" class="spectate-badge">可旁观</span>
          </div>

          <!-- 该游戏的公开游戏桌 -->
          <div v-if="tablesByGame.get(game.id)?.length" class="game-tables">
            <div class="tables-header">公开游戏桌</div>
            <div
              v-for="table in tablesByGame.get(game.id)"
              :key="table.tableId"
              class="table-item"
            >
              <div class="table-info">
                <span class="table-host">
                  <PeerAvatar
                    :avatar="store.members.get(table.hostId)?.profile?.avatar"
                    :seed="table.hostId"
                    :size="16"
                  />
                  {{ getPlayerNick(table.hostId) }}的桌
                </span>
                <span class="table-state">{{ getTableStateText(table) }}</span>
              </div>
              <div class="table-actions">
                <button
                  v-if="table.state === 'waiting'"
                  class="btn-join"
                  @click="joinTable(table.tableId)"
                >
                  加入
                </button>
                <button
                  v-if="game.spectatable && table.state === 'playing'"
                  class="btn-spectate"
                  @click="spectateTable(table.tableId)"
                >
                  旁观
                </button>
              </div>
            </div>
          </div>

          <div class="game-actions">
            <button class="btn-create-public" @click="createTable(game.id, true)">
              创建公开桌
            </button>
            <button
              v-if="game.category !== 'single'"
              class="btn-create-private"
              @click="createTable(game.id, false)"
            >
              创建私密桌
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lobby {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.lobby-header {
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.lobby-header h2 {
  margin: 0 0 16px 0;
  font-size: 24px;
  color: var(--text);
}

.category-tabs {
  display: flex;
  gap: 8px;
}

.category-tabs button {
  padding: 6px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.category-tabs button:hover {
  background: var(--hover);
  color: var(--text);
}

.category-tabs button.active {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.lobby-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.games-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

.game-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: box-shadow 0.2s;
}

.game-card:hover {
  box-shadow: var(--shadow-pop);
}

.game-icon {
  font-size: 48px;
  text-align: center;
}

.game-name {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  text-align: center;
}

.game-desc {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  text-align: center;
  min-height: 36px;
}

.game-info {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.player-count {
  padding: 2px 8px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
}

.spectate-badge {
  padding: 2px 8px;
  background: var(--success-weak);
  color: var(--success);
  border-radius: var(--radius-pill);
}

.game-tables {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: 4px;
}

.tables-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 8px;
}

.table-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  background: var(--bg);
  border-radius: var(--radius);
  margin-bottom: 6px;
  font-size: 12px;
}

.table-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.table-host {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  color: var(--text);
}

.table-state {
  color: var(--muted);
  font-size: 11px;
}

.table-actions {
  display: flex;
  gap: 6px;
}

.btn-join,
.btn-spectate {
  padding: 4px 12px;
  border: none;
  border-radius: var(--radius);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-join {
  background: var(--accent);
  color: white;
}

.btn-join:hover {
  background: var(--accent-strong);
}

.btn-spectate {
  background: var(--muted-weak);
  color: var(--text);
}

.btn-spectate:hover {
  background: var(--hover);
}

.game-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.btn-create-public,
.btn-create-private {
  flex: 1;
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-create-public {
  background: var(--accent);
  color: white;
}

.btn-create-public:hover {
  background: var(--accent-strong);
}

.btn-create-private {
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text);
}

.btn-create-private:hover {
  background: var(--hover);
}
</style>
