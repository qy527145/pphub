<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { type Transfer, useRoomStore } from '@/stores/room'
import { fmtBytes, fmtSpeed } from '@/utils/format'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ t: Transfer }>()
const store = useRoomStore()

// 活跃传输的速率显示需要时间基准；低频刷新即可。
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 600)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const percent = computed(() =>
  props.t.size > 0 ? Math.min(100, Math.floor((props.t.bytes / props.t.size) * 100)) : 0,
)

const speed = computed(() => {
  const end = props.t.finishedAt ?? now.value
  const secs = (end - props.t.startedAt) / 1000
  if (secs <= 0.3 || props.t.bytes === 0) return null
  return fmtSpeed(props.t.bytes / secs)
})

const running = computed(() => props.t.state === 'active' || props.t.state === 'pending')

const STATE_TEXT: Record<Transfer['state'], string> = {
  pending: '等待中',
  active: '传输中',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
}
</script>

<template>
  <div class="item" :class="t.state">
    <div class="fileicon">
      <AppIcon name="file" :size="22" />
    </div>

    <div class="mid">
      <div class="top">
        <span class="name" :title="t.name">{{ t.name }}</span>
        <span class="size">{{ fmtBytes(t.size) }}</span>
      </div>
      <div class="progress" v-if="running">
        <i :style="{ width: percent + '%' }"></i>
      </div>
      <div class="meta">
        <span>{{ t.direction === 'send' ? '发给' : '来自' }} {{ t.peerNick }}</span>
        <span class="state-text" :class="t.state">{{ STATE_TEXT[t.state] }}</span>
        <span v-if="running">{{ percent }}%</span>
        <span v-if="running && speed">{{ speed }}</span>
        <span v-if="t.state === 'done' && speed">均速 {{ speed }}</span>
        <span v-if="t.error" class="err">{{ t.error }}</span>
      </div>
    </div>

    <div class="actions">
      <button v-if="running" class="ghost" title="取消" @click="store.cancelTransfer(t.id)">
        <AppIcon name="x" :size="16" />
      </button>
      <a
        v-else-if="t.state === 'done' && t.url"
        class="save"
        :href="t.url"
        :download="t.name"
        title="另存"
      >
        <AppIcon name="download" :size="16" />
      </a>
    </div>
  </div>
</template>

<style scoped>
.item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}

.item.error { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.item.done { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }

.fileicon {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  background: var(--accent-weak);
  color: var(--accent);
  display: grid;
  place-items: center;
  flex: none;
}

.mid {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.top {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.size {
  font-size: 12px;
  color: var(--muted);
  flex: none;
}

.meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
  flex-wrap: wrap;
}

.state-text.active { color: var(--accent); }
.state-text.done { color: var(--ok); }
.state-text.error, .err { color: var(--danger); }
.state-text.canceled { color: var(--warn); }

.actions {
  flex: none;
  display: flex;
  gap: 6px;
}

.save {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: var(--accent);
}

.save:hover {
  background: var(--accent-weak);
}
</style>
