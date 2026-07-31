<script setup lang="ts">
// 游戏大厅 - 显示所有公开的游戏桌，可以创建新桌子
import { computed, ref, watch } from 'vue'
import { useRoomStore } from '@/stores/room'
import { GAME_CATALOG, getGameMeta, type GameType, type GameTable } from '@/core/games'
import PeerAvatar from './PeerAvatar.vue'
import GameTableView from './GameTable.vue'
import AppIcon from './AppIcon.vue'
import TableJoinDialog from './TableJoinDialog.vue'

const store = useRoomStore()

// 如果用户已在游戏桌中，显示游戏桌界面
const inGameTable = computed(() => !!store.currentTableId)

// 创建桌子对话框
const showCreateDialog = ref(false)
const selectedGameType = ref<GameType>('gomoku')
const isPublicTable = ref(true)
const usePassword = ref(false)
const password = ref('')

// 加入桌子对话框
const showJoinDialog = ref(false)

// 匹配功能：以 store.myMatchingGame 为权威状态，避免本地状态与 store 的超时/取消不同步
const matchGameType = computed(() => store.myMatchingGame)
const matching = computed(() => store.myMatchingGame !== null)

// 所有公开的游戏桌
const publicTables = computed(() => {
  return Array.from(store.gameTables.values())
    .filter(t => t.visibility === 'public')
    .sort((a, b) => {
      // 等待中的桌子排前面
      if (a.state === 'waiting' && b.state !== 'waiting') return -1
      if (a.state !== 'waiting' && b.state === 'waiting') return 1
      // 按创建时间倒序
      return (b.startedAt || 0) - (a.startedAt || 0)
    })
})

function openCreateDialog() {
  showCreateDialog.value = true
  // 重置表单
  usePassword.value = false
  password.value = ''
}

function closeCreateDialog() {
  showCreateDialog.value = false
}

function createTable() {
  const pwd = usePassword.value && password.value.trim() ? password.value.trim() : undefined
  store.createGameTable(selectedGameType.value, isPublicTable.value, pwd)
  closeCreateDialog()
}

function joinTable(tableId: string) {
  store.joinGameTable(tableId, false)
}

function getTableStateText(table: GameTable): string {
  const playerCount = table.players.length
  const spectatorCount = table.spectators.length
  const meta = getGameMeta(table.gameType)

  if (table.state === 'waiting') {
    return `等待中 (${playerCount}/${meta?.playerCount || '?'})`
  } else if (table.state === 'playing') {
    return `游戏中${spectatorCount > 0 ? ` (${spectatorCount}人观战)` : ''}`
  } else {
    return '已结束'
  }
}

function getTableStateClass(table: GameTable): string {
  if (table.state === 'waiting') return 'waiting'
  if (table.state === 'playing') return 'playing'
  return 'finished'
}

function canJoinTable(table: GameTable): boolean {
  if (table.state !== 'waiting') return false
  const meta = getGameMeta(table.gameType)
  return table.players.length < (meta?.playerCount || 999)
}

function getPlayerNick(peerId: string): string {
  return store.displayName(peerId)
}

// 开始匹配
function startMatching(gameType: GameType) {
  store.startMatching(gameType)
}

// 取消匹配
function cancelMatching() {
  if (matchGameType.value) {
    store.cancelMatching(matchGameType.value)
  }
}

// 监听游戏桌变化，实时更新
watch(() => store.gameTables.size, () => {
  // 桌子数量变化时强制更新
}, { flush: 'post' })
</script>

<template>
  <!-- 如果已在游戏桌中，显示游戏桌界面 -->
  <GameTableView v-if="inGameTable" />

  <!-- 否则显示游戏大厅 -->
  <div v-else class="lobby">
    <!-- 匹配中遮罩 -->
    <div v-if="matching" class="matching-overlay">
      <div class="matching-card">
        <div class="matching-spinner">
          <div class="spinner"></div>
        </div>
        <h3>正在匹配 {{ GAME_CATALOG.find(g => g.id === matchGameType)?.name }}...</h3>
        <p>寻找其他玩家中，请稍候</p>
        <button class="btn-cancel-match" @click="cancelMatching">
          取消匹配
        </button>
      </div>
    </div>

    <header class="lobby-header">
      <div class="header-content">
        <h2>🎮 游戏大厅</h2>
        <p class="subtitle">加入公开桌子，或创建自己的游戏桌</p>
      </div>
      <div class="header-actions">
        <button class="btn-join-number" @click="showJoinDialog = true">
          <AppIcon name="hash" :size="16" />
          输入桌号
        </button>
        <button class="btn-create" @click="openCreateDialog">
          <AppIcon name="plus" :size="16" />
          创建游戏桌
        </button>
      </div>
    </header>

    <div class="lobby-content">
      <!-- 游戏目录 -->
      <section class="games-catalog">
        <h3 class="section-title">选择游戏</h3>
        <div class="games-list">
          <div
            v-for="game in GAME_CATALOG"
            :key="game.id"
            class="game-item"
          >
            <div class="game-item-icon">{{ game.icon }}</div>
            <div class="game-item-info">
              <h4>{{ game.name }}</h4>
              <p>{{ game.description }}</p>
              <div class="game-item-meta">
                <span class="meta-tag">{{ game.playerCount }}人</span>
                <span v-if="game.spectatable" class="meta-tag spectatable">可旁观</span>
              </div>
            </div>
            <div class="game-item-actions">
              <button
                v-if="game.category !== 'single'"
                class="btn-match"
                @click="startMatching(game.id)"
                :disabled="matching"
              >
                <AppIcon name="zap" :size="14" />
                快速匹配
              </button>
              <button
                class="btn-create-game"
                @click="() => { selectedGameType = game.id; isPublicTable = true; openCreateDialog(); }"
              >
                <AppIcon name="plus" :size="14" />
                创建桌子
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 公开游戏桌列表 -->
      <section v-if="publicTables.length > 0" class="tables-section">
        <h3 class="section-title">公开游戏桌</h3>
        <div class="tables-grid">
        <div
          v-for="table in publicTables"
          :key="table.tableId"
          class="table-card"
          :class="getTableStateClass(table)"
        >
          <div class="table-header">
            <div class="table-game">
              <span class="game-icon">{{ getGameMeta(table.gameType)?.icon }}</span>
              <div class="game-info">
                <div class="game-title">
                  <h3>{{ getGameMeta(table.gameType)?.name }}</h3>
                  <span v-if="table.tableNumber" class="table-number">#{{ table.tableNumber }}</span>
                  <span v-if="table.hasPassword" class="password-badge" title="需要密码">🔒</span>
                </div>
                <p>{{ getGameMeta(table.gameType)?.description }}</p>
              </div>
            </div>
            <span class="table-state" :class="getTableStateClass(table)">
              {{ getTableStateText(table) }}
            </span>
          </div>

          <div class="table-body">
            <div class="table-host">
              <PeerAvatar
                :avatar="store.members.get(table.hostId)?.profile?.avatar"
                :seed="table.hostId"
                :size="24"
              />
              <span>{{ getPlayerNick(table.hostId) }}的桌子</span>
              <span class="host-badge">桌主</span>
            </div>

            <div class="table-players">
              <div class="players-label">玩家</div>
              <div class="players-list">
                <div
                  v-for="peerId in table.players"
                  :key="peerId"
                  class="player-avatar"
                  :title="getPlayerNick(peerId)"
                >
                  <PeerAvatar
                    :avatar="store.members.get(peerId)?.profile?.avatar"
                    :seed="peerId"
                    :size="32"
                  />
                </div>
                <!-- 空位 -->
                <div
                  v-for="i in Math.max(0, (getGameMeta(table.gameType)?.playerCount || 0) - table.players.length)"
                  :key="`empty-${i}`"
                  class="player-avatar empty"
                >
                  <div class="empty-seat">?</div>
                </div>
              </div>
            </div>
          </div>

          <div class="table-footer">
            <button
              v-if="canJoinTable(table)"
              class="btn-join"
              @click="joinTable(table.tableId)"
            >
              <AppIcon name="log-in" :size="16" />
              加入游戏桌
            </button>
            <button
              v-else-if="table.state === 'playing' && getGameMeta(table.gameType)?.spectatable"
              class="btn-spectate"
              @click="joinTable(table.tableId)"
            >
              <AppIcon name="eye" :size="16" />
              观战
            </button>
            <button v-else class="btn-disabled" disabled>
              {{ table.state === 'finished' ? '已结束' : '已满' }}
            </button>
          </div>
        </div>
        </div>
      </section>
    </div>

    <!-- 创建游戏桌对话框 -->
    <div v-if="showCreateDialog" class="dialog-mask" @click.self="closeCreateDialog">
      <div class="dialog">
        <header class="dialog-header">
          <h3>创建游戏桌</h3>
          <button class="btn-close" @click="closeCreateDialog">
            <AppIcon name="x" :size="16" />
          </button>
        </header>

        <div class="dialog-body">
          <!-- 桌子设置放在最上面 -->
          <div class="form-group">
            <label>桌子设置</label>
            <div class="visibility-toggle">
              <button
                class="toggle-option"
                :class="{ active: isPublicTable }"
                @click="isPublicTable = true"
              >
                <AppIcon name="globe" :size="16" />
                公开桌子
                <span class="option-desc">所有人可见和加入</span>
              </button>
              <button
                class="toggle-option"
                :class="{ active: !isPublicTable }"
                @click="isPublicTable = false"
              >
                <AppIcon name="lock" :size="16" />
                私密桌子
                <span class="option-desc">仅邀请的人可加入</span>
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>
              <input type="checkbox" v-model="usePassword" class="checkbox" />
              设置密码保护
            </label>
            <div v-if="usePassword" class="password-input-group">
              <input
                v-model="password"
                type="password"
                placeholder="输入密码（4-16位）"
                maxlength="16"
                class="password-input"
              />
              <p class="hint">设置密码后，只有知道密码的人才能加入</p>
            </div>
          </div>

          <div class="form-group">
            <label>选择游戏</label>
            <div class="game-select-scroll">
              <div
                v-for="game in GAME_CATALOG"
                :key="game.id"
                class="game-option"
                :class="{ selected: selectedGameType === game.id }"
                @click="selectedGameType = game.id"
              >
                <span class="game-option-icon">{{ game.icon }}</span>
                <div class="game-option-info">
                  <h4>{{ game.name }}</h4>
                  <p>{{ game.description }}</p>
                  <div class="game-option-meta">
                    <span class="game-meta">{{ game.playerCount }}人游戏</span>
                    <span v-if="game.spectatable" class="game-meta spectatable">可旁观</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer class="dialog-footer">
          <button class="btn-cancel" @click="closeCreateDialog">取消</button>
          <button class="btn-confirm" @click="createTable">创建</button>
        </footer>
      </div>
    </div>

    <!-- 加入游戏桌对话框 -->
    <TableJoinDialog v-if="showJoinDialog" @close="showJoinDialog = false" />
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.header-content h2 {
  margin: 0 0 4px 0;
  font-size: 24px;
  color: var(--text);
}

.subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

.header-actions {
  display: flex;
  gap: 12px;
}

.btn-join-number,
.btn-create,
.btn-create-big {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-join-number {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--border);
}

.btn-join-number:hover {
  background: var(--hover);
  border-color: var(--accent);
}

.btn-create,
.btn-create-big {
  background: var(--accent);
  color: white;
}

.btn-create:hover,
.btn-create-big:hover {
  background: var(--accent-strong);
  transform: translateY(-1px);
}

.btn-create-big {
  padding: 12px 24px;
  font-size: 15px;
}

.lobby-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.section-title {
  margin: 0 0 16px 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}

/* 游戏目录 */
.games-catalog {
  margin-bottom: 40px;
}

.games-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.game-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: all 0.2s;
}

.game-item:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-pop);
}

.game-item-icon {
  font-size: 40px;
  flex-shrink: 0;
}

.game-item-info {
  flex: 1;
  min-width: 0;
}

.game-item-info h4 {
  margin: 0 0 4px 0;
  font-size: 16px;
  color: var(--text);
}

.game-item-info p {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: var(--muted);
}

.game-item-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.meta-tag {
  padding: 2px 8px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 600;
}

.meta-tag.spectatable {
  background: var(--success-weak);
  color: var(--success);
}

.game-item-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.btn-match,
.btn-create-game {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-match {
  background: var(--success);
  color: white;
}

.btn-match:hover:not(:disabled) {
  background: var(--success-strong);
  transform: translateY(-1px);
}

.btn-match:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-create-game {
  background: var(--accent);
  color: white;
}

.btn-create-game:hover {
  background: var(--accent-strong);
  transform: translateY(-1px);
}

/* 匹配遮罩 */
.matching-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: grid;
  place-items: center;
  z-index: 1000;
  animation: fadeIn 0.3s;
}

.matching-card {
  background: var(--panel);
  border-radius: var(--radius);
  padding: 40px;
  text-align: center;
  max-width: 400px;
  box-shadow: var(--shadow-pop);
}

.matching-spinner {
  margin-bottom: 24px;
  display: flex;
  justify-content: center;
}

.spinner {
  width: 60px;
  height: 60px;
  border: 4px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.matching-card h3 {
  margin: 0 0 8px 0;
  font-size: 20px;
  color: var(--text);
}

.matching-card p {
  margin: 0 0 24px 0;
  font-size: 14px;
  color: var(--muted);
}

.btn-cancel-match {
  padding: 10px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-cancel-match:hover {
  background: var(--hover);
  border-color: var(--accent);
}

/* 游戏桌区域 */
.tables-section {
  margin-top: 40px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
  text-align: center;
}

.empty-icon {
  font-size: 64px;
  opacity: 0.5;
}

.empty-state h3 {
  margin: 0;
  font-size: 20px;
  color: var(--text);
}

.empty-state p {
  margin: 0;
  font-size: 14px;
  color: var(--muted);
}

.tables-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 20px;
}

.table-card {
  background: var(--panel);
  border: 2px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  transition: all 0.2s;
}

.table-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-pop);
}

.table-card.waiting {
  border-color: var(--success);
}

.table-card.playing {
  border-color: var(--accent);
}

.table-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.table-game {
  display: flex;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.game-icon {
  font-size: 32px;
  flex-shrink: 0;
}

.game-info {
  flex: 1;
  min-width: 0;
}

.game-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.game-info h3 {
  margin: 0;
  font-size: 16px;
  color: var(--text);
}

.table-number {
  padding: 2px 8px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  font-family: monospace;
}

.password-badge {
  font-size: 14px;
}

.game-info p {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-state {
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.table-state.waiting {
  background: var(--success-weak);
  color: var(--success);
}

.table-state.playing {
  background: var(--accent-weak);
  color: var(--accent-strong);
}

.table-state.finished {
  background: var(--muted-weak);
  color: var(--muted);
}

.table-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.table-host {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg);
  border-radius: var(--radius);
  font-size: 13px;
}

.table-host span:nth-child(2) {
  flex: 1;
  color: var(--text);
}

.host-badge {
  padding: 2px 8px;
  background: var(--accent);
  color: white;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 600;
}

.table-players {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.players-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
}

.players-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.player-avatar {
  position: relative;
  flex-shrink: 0;
}

.player-avatar.empty {
  display: grid;
  place-items: center;
}

.empty-seat {
  width: 32px;
  height: 32px;
  border: 2px dashed var(--border);
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 16px;
  color: var(--muted);
  background: var(--bg);
}

.table-footer {
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.btn-join,
.btn-spectate,
.btn-disabled {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  border: none;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 600;
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
  border: 1px solid var(--border);
}

.btn-spectate:hover {
  background: var(--hover);
}

.btn-disabled {
  background: var(--muted-weak);
  color: var(--muted);
  cursor: not-allowed;
  opacity: 0.6;
}

/* 对话框 */
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
  z-index: 100;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.dialog {
  width: min(600px, calc(100vw - 40px));
  max-height: calc(100vh - 80px);
  background: var(--panel);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  display: flex;
  flex-direction: column;
  animation: slideUp 0.3s;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 18px;
  color: var(--text);
}

.btn-close {
  padding: 6px;
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  border-radius: var(--radius);
  transition: all 0.2s;
}

.btn-close:hover {
  background: var(--hover);
  color: var(--text);
}

.dialog-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.form-group {
  margin-bottom: 24px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.checkbox {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.password-input-group {
  margin-top: 12px;
}

.password-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  transition: all 0.2s;
}

.password-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}

.hint {
  margin: 6px 0 0 0;
  font-size: 12px;
  color: var(--muted);
}

.game-select-scroll {
  max-height: 400px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 8px;
}

.game-select-scroll::-webkit-scrollbar {
  width: 6px;
}

.game-select-scroll::-webkit-scrollbar-track {
  background: var(--bg);
  border-radius: 3px;
}

.game-select-scroll::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}

.game-select-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--muted);
}

.game-option {
  display: flex;
  gap: 12px;
  padding: 16px;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.2s;
}

.game-option:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.game-option.selected {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.game-option-icon {
  font-size: 36px;
  flex-shrink: 0;
}

.game-option-info {
  flex: 1;
  min-width: 0;
}

.game-option-info h4 {
  margin: 0 0 4px 0;
  font-size: 15px;
  color: var(--text);
}

.game-option-info p {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: var(--muted);
}

.game-option-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.game-meta {
  display: inline-block;
  padding: 2px 8px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 600;
}

.game-meta.spectatable {
  background: var(--success-weak);
  color: var(--success);
}

.visibility-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.toggle-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: none;
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
}

.toggle-option:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.toggle-option.active {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent-strong);
}

.option-desc {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border);
}

.btn-cancel,
.btn-confirm {
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-cancel {
  background: var(--hover);
  color: var(--text);
}

.btn-cancel:hover {
  background: var(--muted-weak);
}

.btn-confirm {
  background: var(--accent);
  color: white;
}

.btn-confirm:hover {
  background: var(--accent-strong);
}
</style>
