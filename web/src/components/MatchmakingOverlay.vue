<script setup lang="ts">
// 快速匹配全局遮罩（MOBA / 三国杀 风格）：只要 store.myMatchingGame 有值就覆盖全屏，
// 展示雷达搜索动画、已用时、座位逐个填充的进度。匹配到人后短暂显示「匹配成功」再揭开牌桌。
import { computed, ref, watch, onUnmounted } from 'vue'
import { useRoomStore } from '@/stores/room'
import { getGameMeta } from '@/core/games'
import PeerAvatar from './PeerAvatar.vue'

const store = useRoomStore()

const active = computed(() => store.myMatchingGame !== null)
const meta = computed(() => (store.myMatchingGame ? getGameMeta(store.myMatchingGame) : null))
const cap = computed(() => meta.value?.playerCount ?? 0)

// 匹配期间自己所在的等待桌（自建的公开桌）；据此显示已入座玩家。
const table = computed(() => {
  if (!store.currentTableId) return null
  const t = store.gameTables.get(store.currentTableId)
  return t && t.gameType === store.myMatchingGame ? t : null
})

const filled = computed<string[]>(() => {
  if (table.value) return table.value.players
  return store.myId ? [store.myId] : []
})

// 座位槽：已入座的显示头像，其余为「搜索中」。
const slots = computed(() =>
  Array.from({ length: cap.value }, (_, i) => filled.value[i] ?? null),
)

const ready = computed(() => cap.value > 0 && filled.value.length >= cap.value)

// —— 已用时钟 ——
const elapsed = ref(0)
let startAt = 0
let timer: ReturnType<typeof setInterval> | null = null

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null }
}

watch(active, (on) => {
  if (on) {
    startAt = Date.now()
    elapsed.value = 0
    stopTimer()
    timer = setInterval(() => { elapsed.value = Math.floor((Date.now() - startAt) / 1000) }, 1000)
  } else {
    stopTimer()
  }
}, { immediate: true })

// 座位坐满：稍作停留展示「匹配成功」，随后清除匹配态揭开牌桌等待房。
watch(ready, (ok) => {
  if (ok && active.value) {
    setTimeout(() => { store.myMatchingGame = null }, 1200)
  }
})

onUnmounted(stopTimer)

const elapsedText = computed(() => {
  const m = Math.floor(elapsed.value / 60)
  const s = elapsed.value % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

function nick(peerId: string): string {
  return store.displayName(peerId)
}

function cancel() {
  if (store.myMatchingGame) store.cancelMatching(store.myMatchingGame)
}
</script>

<template>
  <Transition name="match-fade">
    <div v-if="active" class="match-overlay">
      <div class="match-stage">
        <!-- 雷达搜索动画 -->
        <div class="radar" :class="{ done: ready }">
          <span class="ring r1"></span>
          <span class="ring r2"></span>
          <span class="ring r3"></span>
          <div class="radar-core">{{ meta?.icon }}</div>
        </div>

        <h2 class="match-title">
          {{ ready ? '匹配成功！' : `正在匹配 ${meta?.name ?? ''}` }}
        </h2>
        <p class="match-sub">
          <span v-if="ready">即将进入牌桌…</span>
          <template v-else>
            <span class="dots">寻找对手中<i>.</i><i>.</i><i>.</i></span>
            <span class="elapsed">已用 {{ elapsedText }}</span>
          </template>
        </p>

        <!-- 座位填充进度 -->
        <div class="seats">
          <div
            v-for="(peerId, i) in slots"
            :key="i"
            class="seat"
            :class="{ filled: !!peerId, me: peerId === store.myId }"
          >
            <div class="seat-avatar">
              <PeerAvatar
                v-if="peerId"
                :avatar="store.members.get(peerId)?.profile?.avatar"
                :seed="peerId"
                :size="48"
              />
              <div v-else class="seat-searching">
                <span class="pulse"></span>
              </div>
            </div>
            <span class="seat-name">{{ peerId ? nick(peerId) : '搜索中' }}</span>
          </div>
        </div>

        <p class="match-count">已就位 {{ filled.length }} / {{ cap }}</p>

        <button v-if="!ready" class="btn-cancel-match" @click="cancel">取消匹配</button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.match-overlay {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 60%),
    rgba(6, 10, 20, 0.86);
  backdrop-filter: blur(4px);
}

.match-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40px;
  color: #fff;
}

/* —— 雷达 —— */
.radar {
  position: relative;
  width: 160px;
  height: 160px;
  display: grid;
  place-items: center;
  margin-bottom: 28px;
}

.ring {
  position: absolute;
  inset: 0;
  margin: auto;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 70%, transparent);
  opacity: 0;
  animation: radar-pulse 2.4s ease-out infinite;
}

.ring.r2 { animation-delay: 0.8s; }
.ring.r3 { animation-delay: 1.6s; }

@keyframes radar-pulse {
  0% { transform: scale(0.35); opacity: 0.9; }
  100% { transform: scale(1); opacity: 0; }
}

.radar-core {
  width: 76px;
  height: 76px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 40px;
  background: var(--brand-grad, var(--accent));
  box-shadow: 0 0 30px color-mix(in srgb, var(--accent) 60%, transparent);
  z-index: 1;
}

.radar.done .ring { animation: none; opacity: 0; }
.radar.done .radar-core {
  animation: pop 0.5s ease;
  box-shadow: 0 0 40px var(--ok, #22c55e);
}

@keyframes pop {
  0% { transform: scale(0.6); }
  60% { transform: scale(1.15); }
  100% { transform: scale(1); }
}

.match-title {
  margin: 0 0 6px;
  font-size: 24px;
  font-weight: 700;
}

.match-sub {
  margin: 0 0 26px;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
  display: flex;
  align-items: center;
  gap: 14px;
}

.dots i {
  animation: blink 1.4s infinite both;
}
.dots i:nth-child(2) { animation-delay: 0.2s; }
.dots i:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 100% { opacity: 0.2; } 50% { opacity: 1; } }

.elapsed {
  font-variant-numeric: tabular-nums;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.12);
}

/* —— 座位 —— */
.seats {
  display: flex;
  gap: 20px;
  margin-bottom: 18px;
}

.seat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 72px;
}

.seat-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  border: 2px solid rgba(255, 255, 255, 0.18);
  padding: 2px;
  transition: all 0.3s;
}

.seat.filled .seat-avatar {
  border-color: var(--accent);
  box-shadow: 0 0 16px color-mix(in srgb, var(--accent) 55%, transparent);
}

.seat.me .seat-avatar {
  border-color: var(--ok, #22c55e);
}

.seat-searching {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.06);
}

.pulse {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.5);
  animation: seat-pulse 1.2s ease-in-out infinite;
}

@keyframes seat-pulse {
  0%, 100% { transform: scale(0.7); opacity: 0.4; }
  50% { transform: scale(1); opacity: 1; }
}

.seat-name {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  max-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.match-count {
  margin: 0 0 24px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.65);
}

.btn-cancel-match {
  padding: 11px 30px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-cancel-match:hover {
  background: rgba(255, 255, 255, 0.18);
}

.match-fade-enter-active,
.match-fade-leave-active {
  transition: opacity 0.3s ease;
}
.match-fade-enter-from,
.match-fade-leave-to {
  opacity: 0;
}
</style>
