<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoomStore } from '@/stores/room'
import type { TransferMode } from '@/core/messages'
import { fmtBytes } from '@/utils/format'
import AppIcon from './AppIcon.vue'
import PeerAvatar from './PeerAvatar.vue'
import TransferItem from './TransferItem.vue'

const store = useRoomStore()

// 目标（单播/广播）跟随网络视图带来的预选，也可在此切换。
const target = ref<'all' | string>(store.sendTarget)
watch(
  () => store.sendTarget,
  (v) => (target.value = v),
)

const mode = ref<TransferMode>('force')
const dragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const sends = computed(() => store.transfers.filter((t) => t.direction === 'send'))
const myShares = computed(() => store.shareList.filter((s) => s.local))
const hasFinished = computed(() =>
  store.transfers.some((t) => t.state !== 'active' && t.state !== 'pending'),
)

const targetValid = computed(
  () =>
    target.value === 'all' ||
    store.connectedPeers.some((p) => p.peerId === target.value),
)

function pick() {
  fileInput.value?.click()
}

function onPicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  if (input.files?.length) sendAll([...input.files])
  input.value = ''
}

function onDrop(ev: DragEvent) {
  dragging.value = false
  const files = [...(ev.dataTransfer?.files ?? [])]
  if (files.length) sendAll(files)
}

function sendAll(files: File[]) {
  store.dispatchFiles(files, mode.value, target.value)
}

const SHARE_STATE: Record<string, string> = {
  idle: '待对方下载',
  downloading: '下载中',
  done: '已完成',
  error: '失败',
}
</script>

<template>
  <div class="page">
    <div class="inner">
      <header class="head">
        <h1><AppIcon name="upload" :size="22" /> 发送文件</h1>
        <p>文件经加密数据通道点对点直达对方设备，不上传任何服务器。</p>
      </header>

      <!-- 未连接：引导 -->
      <div v-if="store.connectedPeers.length === 0" class="empty card">
        <AppIcon name="hub" :size="40" />
        <p>还没有已连接的节点</p>
        <button class="primary" @click="store.setView('network')">去组网</button>
      </div>

      <template v-else>
        <!-- 目标：广播 / 单播 -->
        <div class="targets">
          <span class="lbl">发送给</span>
          <button
            class="chip"
            :class="{ on: target === 'all' }"
            @click="target = 'all'"
          >
            <AppIcon name="hub" :size="14" /> 全网广播（{{ store.connectedPeers.length }}）
          </button>
          <button
            v-for="p in store.connectedPeers"
            :key="p.peerId"
            class="chip"
            :class="{ on: target === p.peerId }"
            @click="target = p.peerId"
          >
            <PeerAvatar :avatar="p.profile?.avatar" :seed="p.peerId" :size="18" />
            {{ store.displayName(p.peerId) }}
          </button>
        </div>

        <!-- 模式：强制 / 懒发送 -->
        <div class="modes">
          <span class="lbl">发送模式</span>
          <label class="mode" :class="{ on: mode === 'force' }">
            <input v-model="mode" type="radio" value="force" name="sendmode" />
            <strong>强制发送</strong>
            <span>选择后立即推送到对方设备</span>
          </label>
          <label class="mode" :class="{ on: mode === 'lazy' }">
            <input v-model="mode" type="radio" value="lazy" name="sendmode" />
            <strong>懒发送</strong>
            <span>只挂出共享，对方点下载才上传；多节点持有时自动多源分流</span>
          </label>
        </div>

        <!-- 拖放区 -->
        <div
          class="drop card"
          :class="{ dragging }"
          @click="pick"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onDrop"
        >
          <input ref="fileInput" type="file" multiple hidden @change="onPicked" />
          <AppIcon name="upload" :size="36" />
          <p class="drop-main">点击选择文件，或拖拽到此处</p>
          <p class="drop-sub">
            {{ mode === 'force' ? '选择后立即开始发送' : '选择后挂出共享，等待对方下载' }}
            {{ targetValid ? '' : '（目标节点已离线，请重选）' }}
          </p>
        </div>
      </template>

      <!-- 我的共享（懒发送挂出的） -->
      <section v-if="myShares.length" class="list">
        <div class="list-head">
          <h2>我的共享（懒发送）</h2>
        </div>
        <div v-for="s in myShares" :key="s.fileId" class="share card">
          <div class="fileicon"><AppIcon name="file" :size="20" /></div>
          <div class="mid">
            <div class="top">
              <span class="name" :title="s.name">{{ s.name }}</span>
              <span class="size">{{ fmtBytes(s.size) }}</span>
            </div>
            <div class="meta">
              <span>{{ s.scope === 'all' ? '对全网可见' : '仅指定节点可见' }}</span>
              <span v-if="s.served > 0" class="up">已供块 {{ s.served }} 次</span>
              <span v-else>{{ SHARE_STATE[s.state] }}</span>
            </div>
          </div>
          <button class="ghost" title="撤销共享" @click="store.revokeShare(s.fileId)">
            <AppIcon name="trash" :size="16" />
          </button>
        </div>
      </section>

      <!-- 发送记录（强制发送） -->
      <section v-if="sends.length" class="list">
        <div class="list-head">
          <h2>发送记录</h2>
          <button v-if="hasFinished" class="ghost" @click="store.clearFinishedTransfers()">
            清除已结束
          </button>
        </div>
        <TransferItem v-for="t in sends" :key="t.id" :t="t" />
      </section>
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

.targets,
.modes {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.lbl {
  color: var(--muted);
  font-size: 13px;
  flex: none;
}

.chip {
  border-radius: var(--radius-pill);
  padding: 5px 13px;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.mode {
  flex: 1;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  cursor: pointer;
  background: var(--panel);
  transition: border-color var(--dur), background var(--dur);
}

.mode input {
  display: none;
}

.mode strong {
  font-size: 13.5px;
}

.mode span {
  font-size: 11.5px;
  color: var(--muted);
}

.mode.on {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.mode.on strong {
  color: var(--accent-strong);
}

.drop {
  padding: 40px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--accent);
  border: 2px dashed var(--border-strong);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.drop:hover,
.drop.dragging {
  background: var(--accent-weak);
  border-color: var(--accent);
}

.drop-main {
  margin: 4px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.drop-sub {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
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
  gap: 4px;
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
}

.up {
  color: var(--ok);
}
</style>
