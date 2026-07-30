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

const isPlayer = computed(() => {
  return currentTable.value?.players.includes(store.myId) ?? false
})

const isSpectator = computed(() => {
  return currentTable.value?.spectators.includes(store.myId) ?? false
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

const canSitDown = computed(() => {
  if (!currentTable.value || currentTable.value.state !== 'waiting') return false
  if (isPlayer.value) return false
  const meta = gameMeta.value
  if (!meta) return false
  return currentTable.value.players.length < meta.playerCount
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

function sitDown() {
  if (!store.currentTableId || !canSitDown.value) return
  store.sitDownAtTable(store.currentTableId)
}

function standUp() {
  if (!store.currentTableId || !isPlayer.value || currentTable.value?.state !== 'waiting') return
  store.standUpFromTable(store.currentTableId)
}

function invitePeer(peerId: string) {
  if (!store.currentTableId) return
  store.inviteToTable(store.currentTableId, peerId)
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

// 可以邀请的网络成员（排除已经在桌上的）
const invitableMembers = computed(() => {
  if (!currentTable.value) return []
  const inTable = new Set([...currentTable.value.players, ...currentTable.value.spectators])
  return store.memberList.filter(m =>
    m.peerId !== store.myId &&
    !inTable.has(m.peerId) &&
    m.state === 'connected'
  )
})

const showInviteDialog = ref(false)

</script>

<template>
  <div v-if="currentTable && gameMeta" class="game-table">
    <header class="table-header">
      <div class="table-info">
        <h2>
          {{ gameMeta.icon }} {{ gameMeta.name }}
          <span v-if="currentTable.tableNumber" class="table-number">#{{ currentTable.tableNumber }}</span>
        </h2>
        <span class="table-state">
          {{ currentTable.state === 'waiting' ? '等待中' : currentTable.state === 'playing' ? '游戏中' : '已结束' }}
        </span>
      </div>
      <div class="header-actions">
        <button v-if="currentTable.state === 'waiting'" class="btn-invite" @click="showInviteDialog = true">
          <AppIcon name="user-plus" :size="16" />
          邀请好友
        </button>
        <button class="btn-leave" @click="leaveTable">
          <AppIcon name="x" :size="16" />
          离开游戏桌
        </button>
      </div>
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
              :class="{ host: peerId === currentTable.hostId, self: peerId === store.myId }"
            >
              <PeerAvatar
                :avatar="store.members.get(peerId)?.profile?.avatar"
                :seed="peerId"
                :size="32"
              />
              <span class="player-name">{{ getPlayerNick(peerId) }}</span>
              <span v-if="peerId === currentTable.hostId" class="host-badge">桌主</span>
              <span v-if="peerId === store.myId" class="self-badge">我</span>
            </div>

            <!-- 空位 -->
            <div
              v-for="i in Math.max(0, gameMeta.playerCount - currentTable.players.length)"
              :key="`empty-${i}`"
              class="player-item empty"
            >
              <div class="empty-avatar">
                <AppIcon name="user" :size="20" />
              </div>
              <span class="player-name">等待玩家...</span>
            </div>
          </div>

          <!-- 坐下/站起按钮 -->
          <div v-if="currentTable.state === 'waiting'" class="seat-actions">
            <button v-if="canSitDown" class="btn-sit" @click="sitDown">
              <AppIcon name="log-in" :size="16" />
              坐下参与游戏
            </button>
            <button v-else-if="isPlayer && !isHost" class="btn-standup" @click="standUp">
              <AppIcon name="log-out" :size="16" />
              站起旁观
            </button>
          </div>
        </div>

        <div v-if="currentTable.spectators.length > 0" class="panel-section">
          <h3>旁观者 ({{ currentTable.spectators.length }})</h3>
          <div class="spectator-list">
            <div
              v-for="peerId in currentTable.spectators"
              :key="peerId"
              class="spectator-item"
              :class="{ self: peerId === store.myId }"
            >
              <PeerAvatar
                :avatar="store.members.get(peerId)?.profile?.avatar"
                :seed="peerId"
                :size="24"
              />
              <span class="spectator-name">{{ getPlayerNick(peerId) }}</span>
              <span v-if="peerId === store.myId" class="self-badge">我</span>
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
          <div v-if="currentTable.state === 'waiting'" class="placeholder-content">
            <div class="placeholder-icon">⏳</div>
            <h3>等待开始...</h3>
            <p v-if="!isPlayer && !isSpectator">请选择坐下或旁观</p>
            <p v-else-if="isSpectator">你正在旁观，等待游戏开始</p>
            <p v-else-if="!canStart">等待玩家坐满...</p>
          </div>
          <div v-else class="placeholder-content">
            <div class="placeholder-icon">🎮</div>
            <h3>游戏进行中</h3>
          </div>
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

    <!-- 邀请对话框 -->
    <div v-if="showInviteDialog" class="dialog-mask" @click.self="showInviteDialog = false">
      <div class="dialog">
        <header class="dialog-header">
          <h3>邀请好友</h3>
          <button class="btn-close" @click="showInviteDialog = false">
            <AppIcon name="x" :size="16" />
          </button>
        </header>
        <div class="dialog-body">
          <div v-if="invitableMembers.length === 0" class="empty-invite">
            <p>暂无可邀请的在线好友</p>
          </div>
          <div v-else class="invite-list">
            <div
              v-for="member in invitableMembers"
              :key="member.peerId"
              class="invite-item"
            >
              <PeerAvatar
                :avatar="member.profile?.avatar"
                :seed="member.peerId"
                :size="32"
              />
              <span class="invite-name">{{ getPlayerNick(member.peerId) }}</span>
              <button class="btn-invite-member" @click="invitePeer(member.peerId)">
                <AppIcon name="user-plus" :size="14" />
                邀请
              </button>
            </div>
          </div>
        </div>
      </div>
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
  display: flex;
  align-items: center;
  gap: 8px;
}

.table-number {
  padding: 2px 8px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
  font-size: 14px;
  font-weight: 600;
  font-family: monospace;
}

.table-state {
  padding: 4px 12px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
  font-size: 13px;
}

.header-actions {
  display: flex;
  gap: 12px;
}

.btn-invite,
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
  font-size: 14px;
}

.btn-invite:hover,
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

.player-item.self {
  background: var(--accent-weak);
}

.player-item.empty {
  border: 2px dashed var(--border);
  background: transparent;
  opacity: 0.5;
}

.empty-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg);
  display: grid;
  place-items: center;
  color: var(--muted);
}

.player-name {
  flex: 1;
  font-size: 13px;
  color: var(--text);
}

.host-badge,
.self-badge {
  padding: 2px 6px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 600;
}

.host-badge {
  background: var(--accent);
  color: white;
}

.self-badge {
  background: var(--success);
  color: white;
}

.seat-actions {
  margin-top: 12px;
}

.btn-sit,
.btn-standup {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px;
  border: none;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-sit {
  background: var(--accent);
  color: white;
}

.btn-sit:hover {
  background: var(--accent-strong);
}

.btn-standup {
  background: var(--muted-weak);
  color: var(--text);
  border: 1px solid var(--border);
}

.btn-standup:hover {
  background: var(--hover);
}

.spectator-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius);
  background: var(--bg);
}

.spectator-item.self {
  background: var(--accent-weak);
}

.spectator-name {
  flex: 1;
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

.placeholder-content {
  text-align: center;
  max-width: 300px;
}

.placeholder-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.placeholder-content h3 {
  margin: 0 0 8px 0;
  font-size: 20px;
  color: var(--text);
}

.placeholder-content p {
  margin: 0;
  font-size: 14px;
  color: var(--muted);
  line-height: 1.5;
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

/* 邀请对话框 */
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
  z-index: 100;
}

.dialog {
  width: min(400px, calc(100vw - 40px));
  max-height: calc(100vh - 80px);
  background: var(--panel);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  display: flex;
  flex-direction: column;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 16px;
  color: var(--text);
}

.btn-close {
  padding: 4px;
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
  padding: 16px 20px;
}

.empty-invite {
  text-align: center;
  padding: 40px 20px;
  color: var(--muted);
}

.invite-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.invite-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg);
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.invite-name {
  flex: 1;
  font-size: 14px;
  color: var(--text);
}

.btn-invite-member {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: white;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-invite-member:hover {
  background: var(--accent-strong);
}
</style>
