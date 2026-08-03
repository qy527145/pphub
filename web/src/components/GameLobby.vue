<script setup lang="ts">
// 游戏大厅 - QQ 游戏大厅风格：真实牌桌图形 + 快速匹配 + 待处理邀请
import { computed, ref } from 'vue'
import { useRoomStore } from '@/stores/room'
import { GAME_CATALOG, getGameMeta, minPlayersOf, maxPlayersOf, type GameType, type GameTable, type GameMeta } from '@/core/games'
import type { Invitation } from '@/core/lobby'
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

// 密码加入：点击带锁的公开桌时先弹出密码输入。
const pendingJoinTable = ref<GameTable | null>(null)
const joinPassword = ref('')

// 桌子筛选（全部 / 指定游戏）
const tableFilter = ref<'all' | GameType>('all')
// 状态筛选（全部 / 等待中 / 游戏中）
const statusFilter = ref<'all' | 'waiting' | 'playing'>('all')
// 桌号搜索
const roomQuery = ref('')

// 匹配功能：以 store.myMatchingGame 为权威状态，匹配 UI 由全局 MatchmakingOverlay 呈现
const matching = computed(() => store.myMatchingGame !== null)

// 选中游戏的元信息（创建对话框预览用）
const selectedMeta = computed(() => getGameMeta(selectedGameType.value))

// 待处理邀请（未过期）。TTL 与 store 一致（60s，按 createdAt 计）。
const INVITE_TTL_MS = 60 * 1000
const invites = computed<Invitation[]>(() =>
  store.pendingInvites.filter((i) => store.inviteClock - i.createdAt < INVITE_TTL_MS),
)

// 所有公开的游戏桌（按筛选：游戏类型 / 状态 / 桌号搜索）
const publicTables = computed(() => {
  const q = roomQuery.value.trim()
  return Array.from(store.gameTables.values())
    .filter((t) => t.visibility === 'public')
    .filter((t) => tableFilter.value === 'all' || t.gameType === tableFilter.value)
    .filter((t) => {
      if (statusFilter.value === 'all') return t.state !== 'finished'
      return t.state === statusFilter.value
    })
    .filter((t) => !q || (t.tableNumber || '').includes(q))
    .sort((a, b) => {
      // 等待中的桌子排前面
      if (a.state === 'waiting' && b.state !== 'waiting') return -1
      if (a.state !== 'waiting' && b.state === 'waiting') return 1
      // 按创建时间倒序
      return (b.startedAt || 0) - (a.startedAt || 0)
    })
})

// 每种游戏的公开桌数量（用于筛选标签徽标）
const tableCountByGame = computed(() => {
  const counts: Record<string, number> = {}
  for (const t of store.gameTables.values()) {
    if (t.visibility !== 'public') continue
    counts[t.gameType] = (counts[t.gameType] || 0) + 1
  }
  return counts
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
  const table = store.gameTables.get(tableId)
  // 带密码的公开桌（非本人托管、尚未在座）：先弹密码框，再带密码入座。
  if (table?.hasPassword && table.hostId !== store.myId && !table.players.includes(store.myId)) {
    pendingJoinTable.value = table
    joinPassword.value = ''
    return
  }
  store.joinGameTable(tableId, false)
}

function confirmJoinWithPassword() {
  const table = pendingJoinTable.value
  if (!table) return
  store.joinGameTable(table.tableId, false, joinPassword.value.trim() || undefined)
  pendingJoinTable.value = null
  joinPassword.value = ''
}

function cancelJoinWithPassword() {
  pendingJoinTable.value = null
  joinPassword.value = ''
}

function spectateTable(tableId: string) {
  store.joinGameTable(tableId, true)
}

// 快速开始：多人游戏走匹配（MOBA 风格遮罩），单机游戏直接开桌进入
function quickPlay(gameType: GameType) {
  if (matching.value) return
  const meta = getGameMeta(gameType)
  if (meta?.category === 'single') {
    store.createGameTable(gameType, false)
  } else {
    store.startMatching(gameType)
  }
}

function getTableStateText(table: GameTable): string {
  const playerCount = table.players.length
  const spectatorCount = table.spectators.length
  const meta = getGameMeta(table.gameType)

  if (table.state === 'waiting') {
    return `等待中 ${playerCount}/${meta ? maxPlayersOf(meta) : '?'}`
  } else if (table.state === 'playing') {
    return `游戏中${spectatorCount > 0 ? ` · ${spectatorCount}人观战` : ''}`
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
  // 等待中的空位任何人可坐；对局进行中仅「原座位离席者」凭 roster 回来续战。
  // 具体判定统一交给 store.canTakeSeat，避免大厅与桌内两处规则漂移。
  return store.canTakeSeat(table)
}

// 玩家位已满或已开局的桌子，若支持旁观则可直接进入观战
function canSpectateTable(table: GameTable): boolean {
  const meta = getGameMeta(table.gameType)
  if (!meta?.spectatable || table.state === 'finished') return false
  return table.state === 'playing' || table.players.length >= maxPlayersOf(meta)
}

function getPlayerNick(peerId: string): string {
  return store.displayName(peerId)
}

// 人数标签：单机=「单机」，固定人数=「N 人」，可变人数=「min-max 人」。
function seatLabel(meta: GameMeta): string {
  if (meta.category === 'single') return '单机'
  const min = minPlayersOf(meta)
  const max = maxPlayersOf(meta)
  return max > min ? `${min}-${max} 人` : `${min} 人`
}

// —— 牌桌座位布局：绕桌一圈均匀分布，从底部开始 ——
interface Seat {
  peerId: string | null
  isHost: boolean
}

function seatsOf(table: GameTable): Seat[] {
  const meta = getGameMeta(table.gameType)
  const cap = meta ? maxPlayersOf(meta) : (table.players.length ?? 0)
  return Array.from({ length: Math.max(cap, 1) }, (_, i) => {
    const peerId = table.players[i] ?? null
    return { peerId, isHost: peerId != null && peerId === table.hostId }
  })
}

// 座位布局按桌记忆一次：模板里每张桌会多处引用（座位圈 + seatStyle 计数），
// 避免每次访问都重建数组。随 publicTables（含 players/hostId）变化重算。
const seatsByTable = computed(() => {
  const m = new Map<string, Seat[]>()
  for (const t of publicTables.value) m.set(t.tableId, seatsOf(t))
  return m
})
function seatsFor(table: GameTable): Seat[] {
  return seatsByTable.value.get(table.tableId) ?? seatsOf(table)
}

function seatStyle(index: number, total: number) {
  // 底部为起点顺时针分布；椭圆半径用百分比，座位用 transform 居中
  const angle = Math.PI / 2 + (index * 2 * Math.PI) / total
  const x = 50 + 42 * Math.cos(angle)
  const y = 50 + 40 * Math.sin(angle)
  return { left: `${x}%`, top: `${y}%` }
}

// —— 邀请 ——
function gameIcon(gt: GameType): string {
  return getGameMeta(gt)?.icon || '🎮'
}
function gameName(gt: GameType): string {
  return getGameMeta(gt)?.name || '游戏'
}
function acceptInvite(inv: Invitation) {
  store.acceptInvite(inv.inviteId)
}
function declineInvite(inv: Invitation) {
  store.declineInvite(inv.inviteId)
}
</script>

<template>
  <!-- 如果已在游戏桌中，显示游戏桌界面 -->
  <GameTableView v-if="inGameTable" />

  <!-- 否则显示游戏大厅 -->
  <div v-else class="lobby">
    <header class="lobby-header">
      <div class="header-content">
        <h2>🎮 游戏大厅</h2>
        <p class="subtitle">加入公开牌桌、快速匹配，或创建自己的游戏桌</p>
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
      <!-- 待处理邀请 -->
      <section v-if="invites.length > 0" class="invites-section">
        <h3 class="section-title">
          <AppIcon name="mail" :size="18" />
          游戏邀请
          <span class="count-pill">{{ invites.length }}</span>
        </h3>
        <div class="invites-list">
          <div v-for="inv in invites" :key="inv.inviteId" class="invite-card">
            <div class="invite-avatar">
              <PeerAvatar
                :avatar="store.members.get(inv.fromPeerId)?.profile?.avatar"
                :seed="inv.fromPeerId"
                :size="40"
              />
              <span class="invite-game-badge">{{ gameIcon(inv.gameType) }}</span>
            </div>
            <div class="invite-text">
              <div class="invite-line">
                <strong>{{ getPlayerNick(inv.fromPeerId) }}</strong> 邀请你玩
                <span class="invite-game">{{ gameName(inv.gameType) }}</span>
              </div>
              <div class="invite-sub">桌号 #{{ inv.tableNumber }}</div>
            </div>
            <div class="invite-actions">
              <button class="btn-accept" @click="acceptInvite(inv)">
                <AppIcon name="check" :size="15" /> 加入
              </button>
              <button class="btn-decline" @click="declineInvite(inv)">
                <AppIcon name="x" :size="15" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 快速匹配：紧凑的游戏选择条，点击即自动组队匹配 -->
      <section class="quick-match">
        <h3 class="section-title">
          <AppIcon name="zap" :size="18" />
          快速匹配
          <span class="qm-hint">选择游戏，自动为你组队匹配对手</span>
        </h3>
        <div class="qm-games">
          <button
            v-for="game in GAME_CATALOG"
            :key="game.id"
            class="qm-game"
            :class="{ single: game.category === 'single' }"
            :disabled="matching"
            :title="game.description"
            @click="quickPlay(game.id)"
          >
            <span class="qm-icon">{{ game.icon }}</span>
            <span class="qm-info">
              <span class="qm-name">{{ game.name }}</span>
              <span class="qm-players">{{ seatLabel(game) }}</span>
            </span>
            <span class="qm-cta">
              <AppIcon :name="game.category === 'single' ? 'play' : 'zap'" :size="13" />
              {{ game.category === 'single' ? '开始' : '匹配' }}
            </span>
          </button>
        </div>
      </section>

      <!-- 公开游戏桌 -->
      <section class="tables-section">
        <div class="tables-head">
          <div class="tables-title-row">
            <h3 class="section-title">游戏桌<span v-if="publicTables.length" class="tables-count">{{ publicTables.length }}</span></h3>
            <div class="table-tools">
              <div class="search-box">
                <AppIcon name="hash" :size="15" />
                <input v-model="roomQuery" type="text" inputmode="numeric" placeholder="搜索桌号" />
                <button v-if="roomQuery" class="search-clear" @click="roomQuery = ''">
                  <AppIcon name="x" :size="13" />
                </button>
              </div>
              <div class="status-tabs">
                <button :class="{ active: statusFilter === 'all' }" @click="statusFilter = 'all'">全部</button>
                <button :class="{ active: statusFilter === 'waiting' }" @click="statusFilter = 'waiting'">等待中</button>
                <button :class="{ active: statusFilter === 'playing' }" @click="statusFilter = 'playing'">游戏中</button>
              </div>
            </div>
          </div>
          <div class="filter-tabs">
            <button
              class="filter-tab"
              :class="{ active: tableFilter === 'all' }"
              @click="tableFilter = 'all'"
            >
              全部
            </button>
            <button
              v-for="game in GAME_CATALOG"
              :key="game.id"
              class="filter-tab"
              :class="{ active: tableFilter === game.id }"
              @click="tableFilter = game.id"
            >
              {{ game.icon }} {{ game.name }}
              <span v-if="tableCountByGame[game.id]" class="tab-count">{{ tableCountByGame[game.id] }}</span>
            </button>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-if="publicTables.length === 0" class="empty-tables">
          <div class="empty-icon">🪑</div>
          <p>{{ roomQuery || statusFilter !== 'all' || tableFilter !== 'all' ? '没有符合条件的游戏桌' : '还没有人开桌，来创建第一桌吧！' }}</p>
          <button class="btn-create" @click="openCreateDialog">
            <AppIcon name="plus" :size="16" />
            创建游戏桌
          </button>
        </div>

        <!-- 牌桌网格 -->
        <div v-else class="tables-grid">
          <div
            v-for="table in publicTables"
            :key="table.tableId"
            class="poker-card"
            :class="getTableStateClass(table)"
          >
            <!-- 顶栏：游戏名 + 桌号 + 状态 -->
            <div class="poker-top">
              <span class="poker-game">{{ getGameMeta(table.gameType)?.icon }} {{ getGameMeta(table.gameType)?.name }}</span>
              <span class="poker-tags">
                <span v-if="table.tableNumber" class="poker-number">#{{ table.tableNumber }}</span>
                <span v-if="table.hasPassword" class="poker-lock" title="需要密码">🔒</span>
              </span>
            </div>

            <!-- 牌桌图形 -->
            <div class="poker-table">
              <div class="felt">
                <div class="felt-center">
                  <span class="felt-icon">{{ getGameMeta(table.gameType)?.icon }}</span>
                  <span class="felt-state" :class="getTableStateClass(table)">
                    {{ getTableStateText(table) }}
                  </span>
                </div>
              </div>
              <!-- 座位 -->
              <div
                v-for="(seat, i) in seatsFor(table)"
                :key="i"
                class="seat"
                :class="{ occupied: !!seat.peerId, host: seat.isHost, joinable: !seat.peerId && canJoinTable(table) }"
                :style="seatStyle(i, seatsFor(table).length)"
                @click="!seat.peerId && canJoinTable(table) && joinTable(table.tableId)"
              >
                <template v-if="seat.peerId">
                  <div class="seat-ava">
                    <PeerAvatar
                      :avatar="store.members.get(seat.peerId)?.profile?.avatar"
                      :seed="seat.peerId"
                      :size="40"
                    />
                    <span v-if="seat.isHost" class="crown" title="桌主">👑</span>
                  </div>
                  <span class="seat-nick">{{ getPlayerNick(seat.peerId) }}</span>
                </template>
                <template v-else>
                  <div class="seat-empty">
                    <AppIcon v-if="canJoinTable(table)" name="plus" :size="18" />
                    <span v-else>空</span>
                  </div>
                  <span class="seat-nick muted">{{ canJoinTable(table) ? '入座' : '虚位' }}</span>
                </template>
              </div>
            </div>

            <!-- 底部操作 -->
            <div class="poker-footer">
              <button v-if="canJoinTable(table)" class="btn-join" @click="joinTable(table.tableId)">
                <AppIcon name="log-in" :size="16" /> 加入游戏桌
              </button>
              <button
                v-else-if="canSpectateTable(table)"
                class="btn-spectate"
                @click="spectateTable(table.tableId)"
              >
                <AppIcon name="eye" :size="16" /> {{ table.state === 'playing' ? '进入观战' : '满员 · 观战' }}
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
          <!-- 下拉选择游戏 -->
          <div class="form-group">
            <label>选择游戏</label>
            <div class="select-wrap">
              <select v-model="selectedGameType" class="game-select">
                <option v-for="game in GAME_CATALOG" :key="game.id" :value="game.id">
                  {{ game.icon }} {{ game.name }}（{{ seatLabel(game) }}）
                </option>
              </select>
              <AppIcon name="chevron-down" :size="16" class="select-arrow" />
            </div>
            <!-- 选中游戏预览 -->
            <div v-if="selectedMeta" class="game-preview">
              <span class="preview-icon">{{ selectedMeta.icon }}</span>
              <div class="preview-info">
                <h4>{{ selectedMeta.name }}</h4>
                <p>{{ selectedMeta.description }}</p>
                <div class="preview-meta">
                  <span class="game-meta">{{ seatLabel(selectedMeta) }}游戏</span>
                  <span v-if="selectedMeta.spectatable" class="game-meta spectatable">可旁观</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 桌子设置 -->
          <div class="form-group">
            <label>桌子设置</label>
            <div class="visibility-toggle">
              <button class="toggle-option" :class="{ active: isPublicTable }" @click="isPublicTable = true">
                <AppIcon name="globe" :size="16" />
                公开桌子
                <span class="option-desc">所有人可见和加入</span>
              </button>
              <button class="toggle-option" :class="{ active: !isPublicTable }" @click="isPublicTable = false">
                <AppIcon name="lock" :size="16" />
                私密桌子
                <span class="option-desc">仅邀请的人可加入</span>
              </button>
            </div>
          </div>

          <!-- 密码保护 -->
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
        </div>

        <footer class="dialog-footer">
          <button class="btn-cancel" @click="closeCreateDialog">取消</button>
          <button class="btn-confirm" @click="createTable">创建</button>
        </footer>
      </div>
    </div>

    <!-- 加入游戏桌对话框 -->
    <TableJoinDialog v-if="showJoinDialog" @close="showJoinDialog = false" />

    <!-- 密码加入对话框（点击带锁的公开桌时弹出） -->
    <div v-if="pendingJoinTable" class="dialog-mask" @click.self="cancelJoinWithPassword">
      <div class="dialog">
        <header class="dialog-header">
          <h3>🔒 需要密码</h3>
          <button class="btn-close" @click="cancelJoinWithPassword">
            <AppIcon name="x" :size="16" />
          </button>
        </header>
        <div class="dialog-body">
          <p class="hint">
            加入
            <strong>{{ getGameMeta(pendingJoinTable.gameType)?.name }}</strong>
            桌 #{{ pendingJoinTable.tableNumber }} 需要密码
          </p>
          <div class="password-input-group">
            <input
              v-model="joinPassword"
              type="password"
              placeholder="输入桌子密码"
              maxlength="16"
              class="password-input"
              @keyup.enter="confirmJoinWithPassword"
            />
          </div>
        </div>
        <footer class="dialog-footer">
          <button class="btn-cancel" @click="cancelJoinWithPassword">取消</button>
          <button class="btn-confirm" @click="confirmJoinWithPassword">加入</button>
        </footer>
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
.btn-create {
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

.btn-create {
  background: var(--accent);
  color: white;
}

.btn-create:hover {
  background: var(--accent-strong);
  transform: translateY(-1px);
}

.lobby-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 16px 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}

.count-pill {
  background: var(--danger);
  color: #fff;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  padding: 2px 9px;
}

/* —— 邀请 —— */
.invites-section {
  margin-bottom: 36px;
  padding: 16px;
  background: var(--accent-weak);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: var(--radius);
}

.invites-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.invite-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background: var(--panel);
  border-radius: var(--radius);
  box-shadow: var(--shadow-soft);
}

.invite-avatar {
  position: relative;
  flex-shrink: 0;
}

.invite-game-badge {
  position: absolute;
  right: -4px;
  bottom: -4px;
  font-size: 15px;
  background: var(--panel);
  border-radius: 50%;
  line-height: 1;
  padding: 1px;
}

.invite-text {
  flex: 1;
  min-width: 0;
}

.invite-line {
  font-size: 14px;
  color: var(--text);
}

.invite-line strong {
  color: var(--accent-strong);
}

.invite-game {
  font-weight: 600;
}

.invite-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--muted);
  font-family: monospace;
}

.invite-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.btn-accept,
.btn-decline {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 14px;
  border: none;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-accept {
  background: var(--accent);
  color: #fff;
}

.btn-accept:hover {
  background: var(--accent-strong);
}

.btn-decline {
  background: var(--hover);
  color: var(--muted);
  padding: 8px 11px;
}

.btn-decline:hover {
  background: var(--muted-weak);
  color: var(--text);
}

/* —— 快速匹配条 —— */
.quick-match {
  margin-bottom: 32px;
}

.qm-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
  margin-left: 4px;
}

.qm-games {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.qm-game {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.2s;
}

.qm-game:hover:not(:disabled) {
  border-color: var(--accent);
  box-shadow: var(--shadow-soft);
  transform: translateY(-1px);
}

.qm-game:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.qm-icon {
  font-size: 26px;
  line-height: 1;
}

.qm-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}

.qm-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.qm-players {
  font-size: 11px;
  color: var(--muted);
}

.qm-cta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  background: var(--success);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}

.qm-game.single .qm-cta {
  background: var(--accent);
}

/* —— 桌子筛选 —— */
.tables-head {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 18px;
}

.tables-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.tables-title-row .section-title {
  margin: 0;
}

.tables-count {
  margin-left: 8px;
  padding: 1px 9px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
  font-size: 13px;
  font-weight: 600;
}

.table-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--panel);
  color: var(--muted);
}

.search-box:focus-within {
  border-color: var(--accent);
}

.search-box input {
  width: 96px;
  border: none;
  background: none;
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.search-clear {
  display: grid;
  place-items: center;
  border: none;
  background: var(--hover);
  color: var(--muted);
  border-radius: 50%;
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.search-clear:hover {
  color: var(--text);
}

.status-tabs {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--panel);
}

.status-tabs button {
  padding: 5px 12px;
  border: none;
  background: none;
  color: var(--text-2);
  font-size: 13px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: all 0.2s;
}

.status-tabs button:hover {
  color: var(--text);
}

.status-tabs button.active {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}

.filter-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--panel);
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.filter-tab:hover {
  border-color: var(--accent);
  color: var(--text);
}

.filter-tab.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}

.tab-count {
  background: color-mix(in srgb, currentColor 20%, transparent);
  border-radius: var(--radius-pill);
  font-size: 11px;
  padding: 0 6px;
  line-height: 16px;
}

/* —— 空状态 —— */
.empty-tables {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 60px 20px;
  color: var(--muted);
}

.empty-icon {
  font-size: 56px;
  opacity: 0.6;
}

.empty-tables p {
  margin: 0;
  font-size: 14px;
}

/* —— 牌桌网格 —— */
.tables-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

.poker-card {
  background: var(--panel);
  border: 2px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: all 0.2s;
}

.poker-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-pop);
}

.poker-card.waiting {
  border-color: var(--success);
}

.poker-card.playing {
  border-color: var(--accent);
}

.poker-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.poker-game {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.poker-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.poker-number {
  padding: 2px 8px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  font-family: monospace;
}

.poker-lock {
  font-size: 13px;
}

/* —— 牌桌图形 —— */
.poker-table {
  position: relative;
  width: 100%;
  aspect-ratio: 5 / 4;
}

.felt {
  position: absolute;
  inset: 16% 10%;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--success) 45%, #0a5c3a) 0%, #0a5c3a 70%, #084a2f 100%);
  border: 4px solid #6b3f1d;
  box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.45), var(--shadow-soft);
  display: grid;
  place-items: center;
}

.felt-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: #fff;
}

.felt-icon {
  font-size: 30px;
  opacity: 0.9;
}

.felt-state {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  background: rgba(0, 0, 0, 0.35);
  white-space: nowrap;
}

.felt-state.waiting { color: #8ef5c0; }
.felt-state.playing { color: #ffe08a; }
.felt-state.finished { color: #cfcfcf; }

/* —— 座位 —— */
.seat {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 60px;
}

.seat.joinable {
  cursor: pointer;
}

.seat-ava {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  padding: 2px;
  background: var(--panel);
  border: 2px solid var(--border-strong);
  box-shadow: var(--shadow-soft);
}

.seat.occupied .seat-ava {
  border-color: var(--accent);
}

.seat.host .seat-ava {
  border-color: var(--warn, #f0a500);
}

.crown {
  position: absolute;
  top: -12px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 14px;
}

.seat-empty {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  border: 2px dashed var(--border-strong);
  background: var(--panel-2);
  color: var(--muted);
  font-size: 12px;
}

.seat.joinable .seat-empty {
  border-color: var(--accent);
  color: var(--accent-strong);
  background: var(--accent-weak);
}

.seat.joinable:hover .seat-empty {
  background: var(--accent);
  color: #fff;
}

.seat-nick {
  font-size: 11px;
  color: var(--text);
  max-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--panel);
  padding: 0 4px;
  border-radius: 4px;
}

.seat-nick.muted {
  color: var(--muted);
  background: transparent;
}

/* —— 牌桌底部 —— */
.poker-footer {
  margin-top: 2px;
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
  color: #fff;
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

/* —— 对话框 —— */
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
  width: min(560px, calc(100vw - 40px));
  max-height: calc(100vh - 80px);
  background: var(--panel);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  display: flex;
  flex-direction: column;
  animation: slideUp 0.3s;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
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

.form-group > label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

/* 下拉选择 */
.select-wrap {
  position: relative;
}

.game-select {
  width: 100%;
  padding: 12px 40px 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  appearance: none;
  transition: all 0.2s;
}

.game-select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}

.select-arrow {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--muted);
  pointer-events: none;
}

.game-preview {
  display: flex;
  gap: 14px;
  margin-top: 14px;
  padding: 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.preview-icon {
  font-size: 40px;
  flex-shrink: 0;
}

.preview-info {
  flex: 1;
  min-width: 0;
}

.preview-info h4 {
  margin: 0 0 4px 0;
  font-size: 15px;
  color: var(--text);
}

.preview-info p {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: var(--muted);
}

.preview-meta {
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
  color: var(--text);
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
  color: #fff;
}

.btn-confirm:hover {
  background: var(--accent-strong);
}
</style>
