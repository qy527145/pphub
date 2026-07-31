<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoomStore } from '@/stores/room'
import { getGameMeta } from '@/core/games'
import type { Invitation } from '@/core/invite-manager'
import AppIcon from './AppIcon.vue'

const store = useRoomStore()

// 用一个每秒推进的时钟触发过期重算，让过期邀请自动从列表消失。
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// 仅展示未过期的邀请（最多 3 条，避免刷屏）
const visibleInvites = computed<Invitation[]>(() =>
  store.pendingInvites.filter((inv) => inv.expiresAt > now.value).slice(0, 3),
)

function infoOf(invite: Invitation) {
  const gameMeta = getGameMeta(invite.gameType)
  return {
    fromNick: store.displayName(invite.fromPeerId),
    gameName: gameMeta?.name || '游戏',
    gameIcon: gameMeta?.icon || '🎮',
    tableNumber: invite.tableNumber,
  }
}

function accept(invite: Invitation) {
  store.acceptInvite(invite.inviteId)
}

function decline(invite: Invitation) {
  store.declineInvite(invite.inviteId)
}
</script>

<template>
  <TransitionGroup name="slide-down" tag="div" class="invite-stack">
    <div
      v-for="invite in visibleInvites"
      :key="invite.inviteId"
      class="invite-notification"
    >
      <div class="invite-icon">{{ infoOf(invite).gameIcon }}</div>
      <div class="invite-content">
        <div class="invite-title">游戏邀请</div>
        <div class="invite-message">
          <strong>{{ infoOf(invite).fromNick }}</strong> 邀请你加入
          <span class="game-name">{{ infoOf(invite).gameName }}</span>
          <span class="table-number">#{{ infoOf(invite).tableNumber }}</span>
        </div>
      </div>
      <div class="invite-actions">
        <button class="btn-accept" @click="accept(invite)">
          <AppIcon name="check" :size="16" />
          加入
        </button>
        <button class="btn-decline" @click="decline(invite)">
          <AppIcon name="x" :size="16" />
        </button>
      </div>
    </div>
  </TransitionGroup>
</template>

<style scoped>
.invite-stack {
  position: fixed;
  top: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 1000;
}

.invite-notification {
  width: min(400px, calc(100vw - 40px));
  background: var(--panel);
  border: 2px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.3s ease;
}

.slide-down-enter-from {
  opacity: 0;
  transform: translateY(-20px);
}

.slide-down-leave-to {
  opacity: 0;
  transform: translateX(420px);
}

.invite-icon {
  font-size: 40px;
  flex-shrink: 0;
}

.invite-content {
  flex: 1;
  min-width: 0;
}

.invite-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  margin-bottom: 4px;
}

.invite-message {
  font-size: 14px;
  color: var(--text);
  line-height: 1.5;
}

.invite-message strong {
  color: var(--accent);
  font-weight: 600;
}

.game-name {
  color: var(--text);
  font-weight: 600;
}

.table-number {
  padding: 2px 6px;
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  font-family: monospace;
  margin-left: 4px;
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
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-accept {
  background: var(--accent);
  color: white;
}

.btn-accept:hover {
  background: var(--accent-strong);
  transform: translateY(-2px);
}

.btn-decline {
  background: var(--hover);
  color: var(--muted);
  padding: 8px 12px;
}

.btn-decline:hover {
  background: var(--muted-weak);
  color: var(--text);
}
</style>
