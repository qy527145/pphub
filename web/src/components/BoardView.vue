<script setup lang="ts">
// 互动白板：固定 16:9 逻辑画板（坐标归一化，各端显示尺寸无关），
// 笔画经 control 通道实时同步；新入房设备自动收到全量状态。
// 支持两类画板：'wb' 公共白板（全网同步）与 wb:<a>~<b> 私有白板（仅两端）。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoomStore } from '@/stores/room'
import { containRect, renderStrokes } from '@/core/draw'
import type { DrawMode } from '@/core/messages'
import AppIcon from './AppIcon.vue'
import PeerAvatar from './PeerAvatar.vue'
import DrawLayer from './DrawLayer.vue'
import DrawToolbar from './DrawToolbar.vue'

/** 导出 PNG 的像素尺寸。 */
const EXPORT_W = 1920
const EXPORT_H = 1080

const store = useRoomStore()

/** 当前画板：跟随 store.activeBoard（网络视图「私有白板」入口设置）。 */
const board = computed(() => store.activeBoard)
const isPrivate = computed(() => board.value.startsWith('wb:'))
/** 私有画板的对方节点。 */
const dmPeer = computed(() => {
  if (!isPrivate.value) return null
  return board.value.slice(3).split('~').find((p) => p !== store.myId) ?? null
})

const tool = ref<'pointer' | DrawMode>('pen')
const color = ref('#6c4bf4')
const size = ref(3)

// —— 16:9 letterbox 几何 ——
const wrapEl = ref<HTMLDivElement | null>(null)
const wrapW = ref(0)
const wrapH = ref(0)
const rect = computed(() => containRect(wrapW.value, wrapH.value, 16, 9))

let resizeObs: ResizeObserver | null = null

onMounted(() => {
  resizeObs = new ResizeObserver(() => {
    if (!wrapEl.value) return
    wrapW.value = wrapEl.value.clientWidth
    wrapH.value = wrapEl.value.clientHeight
  })
  if (wrapEl.value) resizeObs.observe(wrapEl.value)
})

onBeforeUnmount(() => resizeObs?.disconnect())

function clear(): void {
  if (store.getBoard(board.value).length === 0) return
  if (!window.confirm('清空白板？将同时清掉参与者的画面。')) return
  store.clearBoard(board.value)
}

/** 导出当前白板为 PNG（白底）。 */
function exportPng(): void {
  const canvas = document.createElement('canvas')
  canvas.width = EXPORT_W
  canvas.height = EXPORT_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, EXPORT_W, EXPORT_H)
  // renderStrokes 会 clearRect，导出时先画笔画再垫白底。
  const strokesLayer = document.createElement('canvas')
  strokesLayer.width = EXPORT_W
  strokesLayer.height = EXPORT_H
  const sctx = strokesLayer.getContext('2d')
  if (!sctx) return
  renderStrokes(sctx, store.getBoard(board.value), EXPORT_W, EXPORT_H)
  ctx.drawImage(strokesLayer, 0, 0)
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `whiteboard-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }, 'image/png')
}

const syncHint = computed(() => {
  if (isPrivate.value) {
    const peer = dmPeer.value
    const reachable = peer && store.members.get(peer)?.state === 'connected'
    return reachable
      ? `与 ${store.displayName(peer)} 的私有白板 · 其他节点不可见`
      : '对方暂不可达（笔画会先留在本地）'
  }
  const n = store.connectedPeers.length
  return n > 0 ? `与 ${n} 个节点实时同步` : '未连接节点（先本地起草，组网后自动同步）'
})
</script>

<template>
  <div class="boardpage">
    <header class="head">
      <h1><AppIcon name="pen" :size="20" /> 互动白板</h1>
      <span class="sub">{{ syncHint }}</span>
      <button class="ghost" title="导出 PNG" @click="exportPng">
        <AppIcon name="image" :size="16" /> 导出
      </button>
    </header>

    <!-- 画板切换：公共 + 各私有板 -->
    <div v-if="store.memberList.length > 0" class="tabs">
      <button
        class="tab"
        :class="{ on: !isPrivate }"
        @click="store.actionBoard('all')"
      >
        <AppIcon name="hub" :size="14" /> 公共白板
      </button>
      <button
        v-for="m in store.memberList"
        :key="m.peerId"
        class="tab"
        :class="{ on: isPrivate && dmPeer === m.peerId }"
        @click="store.actionBoard(m.peerId)"
      >
        <PeerAvatar :avatar="m.profile?.avatar" :seed="m.peerId" :size="16" />
        与 {{ store.displayName(m.peerId) }}
      </button>
    </div>

    <div class="tools">
      <DrawToolbar
        v-model:tool="tool"
        v-model:color="color"
        v-model:size="size"
        pointer-label="激光笔（位置实时投给参与者）"
        @undo="store.undoStroke(board)"
        @clear="clear"
      />
    </div>

    <div ref="wrapEl" class="wrap">
      <div
        class="board"
        :style="{
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        }"
      >
        <DrawLayer
          v-if="rect.width > 0"
          :key="board"
          :board="board"
          :tool="tool"
          :color="color"
          :size="size"
          :width="rect.width"
          :height="rect.height"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.boardpage {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

.head h1 {
  margin: 0;
  font-size: 17px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent-strong);
}

.sub {
  font-size: 12px;
  color: var(--muted);
  flex: 1;
}

.tabs {
  display: flex;
  gap: 6px;
  padding: 10px 24px 0;
  flex-wrap: wrap;
}

.tab {
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  font-size: 12.5px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.head .ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tools {
  display: flex;
  justify-content: center;
  padding: 12px 24px 0;
}

.wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  margin: 12px 24px 20px;
}

.board {
  position: absolute;
  background: var(--canvas);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}
</style>
