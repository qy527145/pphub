<script setup lang="ts">
import { computed } from 'vue'
import { useRoomStore } from '@/stores/room'
import { fmtBytes } from '@/utils/format'
import AppIcon from './AppIcon.vue'
import TransferItem from './TransferItem.vue'

const store = useRoomStore()

const recvs = computed(() => store.transfers.filter((t) => t.direction === 'recv'))
/** 别人挂出的共享（可下载）。 */
const remoteShares = computed(() => store.shareList.filter((s) => !s.local))
const hasFinished = computed(() =>
  recvs.value.some((t) => t.state !== 'active' && t.state !== 'pending'),
)

function percent(bytes: number, size: number): number {
  return size > 0 ? Math.min(100, Math.floor((bytes / size) * 100)) : 0
}
</script>

<template>
  <div class="page">
    <div class="inner">
      <header class="head">
        <h1><AppIcon name="download" :size="22" /> 接收文件</h1>
        <p>对方直发的文件自动接收；对方挂出的共享按需下载，多节点持有时自动多源分流。</p>
      </header>

      <div v-if="store.status !== 'online'" class="empty card">
        <AppIcon name="hub" :size="40" />
        <p>未在线：先组网，或打开「允许短码连我」等待对方连入</p>
        <button class="primary" @click="store.setView('network')">去组网</button>
      </div>

      <div v-else-if="recvs.length === 0 && remoteShares.length === 0" class="empty card">
        <span class="pulse"></span>
        <p>
          {{
            store.peerCount > 0
              ? '已组网，等待对方发送或共享文件…'
              : `等待连入：把短码 ${store.myCode} 告诉对方即可`
          }}
        </p>
      </div>

      <!-- 网络中的共享（懒发送，可下载） -->
      <section v-if="remoteShares.length" class="list">
        <div class="list-head">
          <h2>网络中的共享</h2>
        </div>
        <div v-for="s in remoteShares" :key="s.fileId" class="share card" :class="s.state">
          <div class="fileicon"><AppIcon name="file" :size="20" /></div>
          <div class="mid">
            <div class="top">
              <span class="name" :title="s.name">{{ s.name }}</span>
              <span class="size">{{ fmtBytes(s.size) }}</span>
            </div>
            <div v-if="s.state === 'downloading'" class="progress">
              <i :style="{ width: percent(s.bytes, s.size) + '%' }"></i>
            </div>
            <div class="meta">
              <span>来自 {{ store.displayName(s.ownerId) }}</span>
              <span v-if="s.state === 'downloading'" class="dl">
                {{ percent(s.bytes, s.size) }}% ·
                {{ s.sources > 1 ? `${s.sources} 源并行下载` : `${Math.max(1, s.sources)} 源下载` }}
              </span>
              <span v-else-if="s.state === 'done'" class="ok">已完成</span>
              <span v-else-if="s.state === 'error'" class="err">{{ s.error ?? '失败' }}</span>
              <span v-else>待下载</span>
            </div>
          </div>
          <div class="actions">
            <button
              v-if="s.state === 'idle' || s.state === 'error'"
              class="primary small"
              @click="store.downloadShare(s.fileId)"
            >
              <AppIcon name="download" :size="15" /> 下载
            </button>
            <button
              v-else-if="s.state === 'downloading'"
              class="ghost"
              title="取消"
              @click="store.cancelDownload(s.fileId)"
            >
              <AppIcon name="x" :size="16" />
            </button>
            <a
              v-else-if="s.state === 'done' && s.url"
              class="save"
              :href="s.url"
              :download="s.name"
              title="另存"
            >
              <AppIcon name="download" :size="16" />
            </a>
          </div>
        </div>
      </section>

      <!-- 直发接收记录 -->
      <section v-if="recvs.length" class="list">
        <div class="list-head">
          <h2>接收记录</h2>
          <button v-if="hasFinished" class="ghost" @click="store.clearFinishedTransfers()">
            清除已结束
          </button>
        </div>
        <TransferItem v-for="t in recvs" :key="t.id" :t="t" />
      </section>

      <p v-if="recvs.length || remoteShares.length" class="tip">
        提示：大文件当前在内存中暂存后保存，桌面浏览器建议单文件不超过 1GB。
      </p>
    </div>
  </div>
</template>

<style scoped>
.page {
  flex: 1;
  overflow-y: auto;
  padding: 36px 28px;
}

.inner {
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.head h1 {
  margin: 0;
  font-size: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--accent-strong);
}

.head p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.empty {
  padding: 48px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--muted);
}

.pulse {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--ok);
  animation: pulse 1.6s ease-out infinite;
}

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 45%, transparent); }
  100% { box-shadow: 0 0 0 10px transparent; }
}

.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.list-head h2 {
  margin: 0;
  font-size: 15px;
}

.share {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  box-shadow: none;
}

.share.done { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
.share.error { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }

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

.dl { color: var(--accent); }
.ok { color: var(--ok); }
.err { color: var(--danger); }

.actions {
  flex: none;
  display: flex;
  gap: 6px;
}

.small {
  padding: 6px 12px;
  font-size: 12.5px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
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

.tip {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
</style>
