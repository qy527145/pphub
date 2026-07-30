<script setup lang="ts">
import { computed } from 'vue'
import { useRoomStore } from '@/stores/room'
import { getGameMeta } from '@/core/games'
import type { Invitation } from '@/core/invite-manager'
import AppIcon from './AppIcon.vue'

const store = useRoomStore()

const latestInvite = computed<Invitation | null>(() => {
  return store.pendingInvites.length > 0 ? store.pendingInvites[0] : null
})

const inviteInfo = computed(() => {
  if (!latestInvite.value) return null

  const fromNick = store.displayName(latestInvite.value.fromPeerId)
  const gameMeta = getGameMeta(latestInvite.value.gameType)

  return {
    fromNick,
    gameName: gameMeta?.name || '游戏',
    gameIcon: gameMeta?.icon || '🎮',
    tableNumber: latestInvite.value.tableNumber,
  }
})

function accept() {
  if (!latestInvite.value) return
  store.acceptInvite(latestInvite.value.inviteId)
}

function decline() {
  if (!latestInvite.value) return
  store.declineInvite(latestInvite.value.inviteId)
}
</script>

<template>
  <Transition name="slide-down">
    <div v-if="latestInvite && inviteInfo" class="invite-notification">
      <div class="invite-icon">{{ inviteInfo.gameIcon }}</div>
      <div class="invite-content">
        <div class="invite-title">游戏邀请</div>
        <div class="invite-message">
          <strong>{{ inviteInfo.fromNick }}</strong> 邀请你加入
          <span class="game-name">{{ inviteInfo.gameName }}</span>
          <span class="table-number">#{{ inviteInfo.tableNumber }}</span>
        </div>
      </div>
      <div class="invite-actions">
        <button class="btn-accept" @click="accept">
          <AppIcon name="check" :size="16" />
          加入
        </button>
        <button class="btn-decline" @click="decline">
          <AppIcon name="x" :size="16" />
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.invite-notification {
  position: fixed;
  top: 20px;
  right: 20px;
  width: min(400px, calc(100vw - 40px));
  background: var(--panel);
  border: 2px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  z-index: 1000;
  animation: bounce 0.5s;
}

@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-10px); }
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
