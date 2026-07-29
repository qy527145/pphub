<script setup lang="ts">
// 游戏桌视图 - 显示当前加入的游戏桌，包括游戏区域、聊天框、玩家列表等
import { computed, ref } from 'vue'
import { useRoomStore } from '@/stores/room'
import { getGameMeta } from '@/core/games'
import AppIcon from './AppIcon.vue'
import PeerAvatar from './PeerAvatar.vue'
import ChompGame from './ChompGame.vue'
import GomokuGame from './GomokuGame.vue'
import XiangqiGame from './XiangqiGame.vue'

const store = useRoomStore()

const currentTable = computed(() => {
  if (!store.currentTableId) return null
  return store.gameTables.get(store.currentTableId)
})

const gameMeta = computed(() => {
  if (!currentTable.value) return null
  return getGameMeta(currentTable.value.gameType)
})

const isHost = computed(() => {
  return currentTable.value?.hostId === store.myId
})

const canStart = computed(() => {
  if (!currentTable.value || !isHost.value || currentTable.value.state !== 'waiting') {
    return false
  }
  const meta = gameMeta.value
  if (!meta) return false

  const playerCount = currentTable.value.players.length
  if (meta.category === 'single') return playerCount === 1
  if (meta.category === 'double') return playerCount === meta.playerCount
  return playerCount >= meta.playerCount
})

const chatInput = ref('')
const chatMessages = computed(() => {
  if (!store.currentTableId) return []
  return store.gameChats.get(store.currentTableId) || []
})

function sendChat() {
  if (!chatInput.value.trim() || !store.currentTableId) return
  store.sendGameChat(store.currentTableId, chatInput.value.trim())
  chatInput.value = ''
}

function startGame() {
  if (!store.currentTableId || !canStart.value) return
  store.startGameTable(store.currentTableId)
}

function leaveTable() {
  store.leaveGameTable()
}

function getPlayerNick(peerId: string): string {
  return store.displayName(peerId)
}

// 鼠标位置共享
const gameArea = ref<HTMLElement | null>(null)

function handleMouseMove(ev: MouseEvent) {
  if (!gameArea.value || !store.currentTableId) return
  const rect = gameArea.value.getBoundingClientRect()
  const x = (ev.clientX - rect.left) / rect.width
  const y = (ev.clientY - rect.top) / rect.height
  store.sendGameMousePos(store.currentTableId, x, y)
}

const remotePointers = computed(() => {
  if (!store.currentTableId) return []
  return store.gameMousePositions.get(store.currentTableId) || []
})
</script>

<template>
  <div v-if="currentTable && gameMeta" class="game-table">
    <header class="table-header">
      <div class="table-info">
        <h2>{{ gameMeta.icon }} {{ gameMeta.name }}</h2>
        <span class="table-state">
          {{ currentTable.state === 'waiting' ? '等待中' : currentTable.state === 'playing' ? '游戏中' : '已结束' }}
        </span>
      </div>
      <button class="btn-leave" @click="leaveTable">
        <AppIcon name="x" :size="16" />
        离开游戏桌
      </button>
    </header>

    <div class="table-content">
      <!-- 左侧：玩家列表和旁观者 -->
      <aside class="players-panel">
        <div class="panel-section">
          <h3>玩家 ({{ currentTable.players.length }}/{{ gameMeta.playerCount }})</h3>
          <div class="player-list">
            <div
              v-for="peerId in currentTable.players"
              :key="peerId"
              class="player-item"
              :class="{ host: peerId === currentTable.hostId }"
            >
              <PeerAvatar
                :avatar="store.members.get(peerId)?.profile?.avatar"
                :seed="peerId"
                :size="32"
              />
              <span class="player-name">{{ getPlayerNick(peerId) }}</span>
              <span v-if="peerId === currentTable.hostId" class="host-badge">桌主</span>
            </div>
          </div>
        </div>

        <div v-if="gameMeta.spectatable && currentTable.spectators.length > 0" class="panel-section">
          <h3>旁观者 ({{ currentTable.spectators.length }})</h3>
          <div class="spectator-list">
            <div v-for="peerId in currentTable.spectators" :key="peerId" class="spectator-item">
              <PeerAvatar
                :avatar="store.members.get(peerId)?.profile?.avatar"
                :seed="peerId"
                :size="24"
              />
              <span class="spectator-name">{{ getPlayerNick(peerId) }}</span>
            </div>
          </div>
        </div>

        <div v-if="isHost && currentTable.state === 'waiting'" class="start-area">
          <button
            class="btn-start"
            :disabled="!canStart"
            @click="startGame"
          >
            开始游戏
          </button>
          <p v-if="!canStart" class="start-hint">
            需要 {{ gameMeta.playerCount }} 名玩家
          </p>
        </div>
      </aside>

      <!-- 中间：游戏区域 -->
      <div class="game-area" ref="gameArea" @mousemove="handleMouseMove">
        <ChompGame v-if="currentTable.gameType === 'chomp'" :table="currentTable" />
        <GomokuGame v-else-if="currentTable.gameType === 'gomoku'" :table="currentTable" />
        <XiangqiGame v-else-if="currentTable.gameType === 'xiangqi'" :table="currentTable" />
        <div v-else class="game-placeholder">
          {{ currentTable.state === 'waiting' ? '等待开始...' : '游戏进行中' }}
        </div>

        <!-- 远程鼠标指针 -->
        <div
          v-for="pointer in remotePointers"
          :key="pointer.peerId"
          class="remote-pointer"
          :style="{
            left: `${pointer.x * 100}%`,
            top: `${pointer.y * 100}%`,
          }"
        >
          <div class="pointer-icon">👆</div>
          <div class="pointer-label">{{ getPlayerNick(pointer.peerId) }}</div>
        </div>
      </div>

      <!-- 右侧：聊天框 -->
      <aside class="chat-panel">
        <h3>游戏聊天</h3>
        <div class="chat-messages">
          <div v-for="(msg, i) in chatMessages" :key="i" class="chat-message">
            <div class="msg-header">
              <span class="msg-from">{{ getPlayerNick(msg.from) }}</span>
              <span class="msg-role" :class="msg.role">{{ msg.role === 'player' ? '玩家' : '旁观' }}</span>
            </div>
            <div class="msg-text">{{ msg.text }}</div>
          </div>
        </div>
        <div class="chat-input">
          <input
            v-model="chatInput"
            type="text"
            placeholder="输入消息..."
            @keydown.enter="sendChat"
          />
          <button @click="sendChat">
            <AppIcon name="send" :size="16" />
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.game-table {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.table-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.table-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.table-info h2 {
  margin: 0;
  font-size: 20px;
  color: var(--text);
}

.table-state {
  padding: 4px 12px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
  font-size: 13px;
}

.btn-leave {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-leave:hover {
  background: var(--hover);
}

.table-content {
  flex: 1;
  display: grid;
  grid-template-columns: 200px 1fr 280px;
  gap: 1px;
  background: var(--border);
  overflow: hidden;
}

.players-panel,
.chat-panel {
  background: var(--panel);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.players-panel {
  padding: 16px;
}

.panel-section {
  margin-bottom: 20px;
}

.panel-section h3 {
  margin: 0 0 12px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
}

.player-list,
.spectator-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.player-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: var(--radius);
  background: var(--bg);
}

.player-item.host {
  border: 1px solid var(--accent);
}

.player-name {
  flex: 1;
  font-size: 13px;
  color: var(--text);
}

.host-badge {
  padding: 2px 6px;
  background: var(--accent);
  color: white;
  border-radius: var(--radius-pill);
  font-size: 11px;
}

.spectator-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius);
  background: var(--bg);
}

.spectator-name {
  font-size: 12px;
  color: var(--muted);
}

.start-area {
  margin-top: auto;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.btn-start {
  width: 100%;
  padding: 10px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-start:hover:not(:disabled) {
  background: var(--accent-strong);
}

.btn-start:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.start-hint {
  margin: 8px 0 0 0;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}

.game-area {
  position: relative;
  background: var(--bg);
  overflow: hidden;
}

.game-placeholder {
  display: grid;
  place-items: center;
  height: 100%;
  font-size: 18px;
  color: var(--muted);
}

.remote-pointer {
  position: absolute;
  pointer-events: none;
  transform: translate(-50%, -50%);
  z-index: 100;
}

.pointer-icon {
  font-size: 24px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.pointer-label {
  margin-top: 4px;
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  border-radius: var(--radius);
  font-size: 11px;
  white-space: nowrap;
}

.chat-panel {
  padding: 16px;
}

.chat-panel h3 {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
}

.chat-message {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.msg-from {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.msg-role {
  padding: 1px 5px;
  border-radius: var(--radius-pill);
  font-size: 10px;
}

.msg-role.player {
  background: var(--accent-weak);
  color: var(--accent-strong);
}

.msg-role.spectator {
  background: var(--muted-weak);
  color: var(--muted);
}

.msg-text {
  padding: 6px 10px;
  background: var(--hover);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--text);
  word-break: break-word;
}

.chat-input {
  display: flex;
  gap: 8px;
}

.chat-input input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}

.chat-input button {
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: white;
  cursor: pointer;
  transition: all 0.2s;
}

.chat-input button:hover {
  background: var(--accent-strong);
}
</style>
