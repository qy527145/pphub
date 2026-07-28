<script setup lang="ts">
// 屏幕共享：本端 getDisplayMedia 采集 → 媒体轨经各对端连接直传；
// 观看端在视频上叠加 DrawLayer——远程指针 / 点击提示 / 透明画笔批注，
// 同样的叠加也渲染在共享端预览上，形成「远程指挥」闭环。
// 注：浏览器安全模型不允许网页向对端操作系统注入键鼠事件（Captured
// Surface Control 亦仅转发本机可信事件），故不存在纯浏览器的完整远控。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoomStore } from '@/stores/room'
import { containRect } from '@/core/draw'
import type { DrawMode } from '@/core/messages'
import AppIcon from './AppIcon.vue'
import DrawLayer from './DrawLayer.vue'
import DrawToolbar from './DrawToolbar.vue'

const store = useRoomStore()

// —— 工具状态 ——
const tool = ref<'pointer' | DrawMode>('pointer')
const color = ref('#e5484d')
const size = ref(6)
const muted = ref(true)
const polylineArrow = ref(false)
const layerRef = ref<InstanceType<typeof DrawLayer> | null>(null)
const selectedCount = computed(() => layerRef.value?.selectedCount ?? 0)

// 切换工具时把粗细落到该工具的可选档位上
function setTool(next: 'pointer' | DrawMode): void {
  tool.value = next
  if (next === 'eraser') size.value = 36
  else if (next === 'text') size.value = 24
  else if (next !== 'pointer' && next !== 'select' && next !== 'image') size.value = 6
}

// —— 画面源 ——
interface Feed {
  id: string
  label: string
  live: boolean
}

const feeds = computed<Feed[]>(() => {
  const list: Feed[] = []
  if (store.sharing) list.push({ id: 'self', label: '我的屏幕', live: true })
  for (const m of store.sharers) {
    list.push({
      id: m.peerId,
      label: store.displayName(m.peerId),
      live: store.remoteScreens.has(m.peerId),
    })
  }
  return list
})

const activeStream = computed<MediaStream | null>(() => {
  if (store.watching === 'self') return store.localScreen
  if (store.watching) return store.remoteScreens.get(store.watching) ?? null
  return null
})

/** 当前画面对应的批注层 board id。 */
const activeBoard = computed(() =>
  store.watching === 'self' ? `screen:${store.myId}` : `screen:${store.watching}`,
)

const hasAudio = computed(
  () => store.watching !== 'self' && (activeStream.value?.getAudioTracks().length ?? 0) > 0,
)

// —— 视频几何：object-fit contain 的内容区，供 DrawLayer 对齐 ——
const stageEl = ref<HTMLDivElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const stageW = ref(0)
const stageH = ref(0)
const videoW = ref(0)
const videoH = ref(0)

const content = computed(() => containRect(stageW.value, stageH.value, videoW.value, videoH.value))

let resizeObs: ResizeObserver | null = null

onMounted(() => {
  resizeObs = new ResizeObserver(() => {
    if (!stageEl.value) return
    stageW.value = stageEl.value.clientWidth
    stageH.value = stageEl.value.clientHeight
  })
  if (stageEl.value) resizeObs.observe(stageEl.value)
})

onBeforeUnmount(() => resizeObs?.disconnect())

function onVideoMeta(): void {
  const v = videoEl.value
  if (!v) return
  videoW.value = v.videoWidth
  videoH.value = v.videoHeight
}

watch(
  [activeStream, videoEl],
  () => {
    const v = videoEl.value
    if (!v) return
    if (v.srcObject !== activeStream.value) {
      videoW.value = 0
      videoH.value = 0
      v.srcObject = activeStream.value
    }
  },
  { flush: 'post' },
)

// —— 操作 ——
/** 共享目标：all=全网，否则为指定对端 peerId。 */
const shareTarget = ref<'all' | string>('all')

async function share(): Promise<void> {
  const ok = await store.startShare(
    shareTarget.value === 'all' ? 'all' : 'direct',
    shareTarget.value === 'all' ? undefined : shareTarget.value,
  )
  if (ok) store.watching = 'self'
}

function clearAnno(): void {
  store.clearBoard(activeBoard.value)
}

const canShare = computed(() => store.capabilities.displayMedia && store.status === 'online')
</script>

<template>
  <div class="screenpage">
    <header class="head">
      <h1><AppIcon name="monitor" :size="20" /> 屏幕共享</h1>
      <span class="sub">
        {{
          store.sharing
            ? store.sharingScope.scope === 'direct'
              ? `正在共享给 ${store.displayName(store.sharingScope.to ?? '')} · 端到端直传`
              : '正在向全网共享你的屏幕 · 端到端直传'
            : store.sharers.length > 0
              ? `${store.sharers.length} 人正在共享`
              : '共享屏幕或观看他人画面'
        }}
      </span>
      <button v-if="store.sharing" class="danger-btn" @click="store.stopShare()">
        <AppIcon name="stop-circle" :size="15" /> 停止共享
      </button>
      <template v-else>
        <select v-if="store.connectedPeers.length > 0" v-model="shareTarget" class="target-sel">
          <option value="all">全网广播</option>
          <option v-for="p in store.connectedPeers" :key="p.peerId" :value="p.peerId">
            仅 {{ store.displayName(p.peerId) }}
          </option>
        </select>
        <button class="primary sharebtn" :disabled="!canShare" @click="share">
          <AppIcon name="monitor" :size="15" /> 共享我的屏幕
        </button>
      </template>
    </header>

    <div v-if="feeds.length > 1" class="tabs">
      <button
        v-for="f in feeds"
        :key="f.id"
        class="tab"
        :class="{ on: store.watching === f.id }"
        @click="store.watching = f.id"
      >
        {{ f.label }}
        <span v-if="!f.live" class="pending">连接中</span>
      </button>
    </div>

    <div ref="stageEl" class="stage">
      <template v-if="activeStream">
        <video
          ref="videoEl"
          autoplay
          playsinline
          :muted="store.watching === 'self' || muted"
          @loadedmetadata="onVideoMeta"
          @resize="onVideoMeta"
        />
        <DrawLayer
          v-if="content.width > 0"
          ref="layerRef"
          class="overlay"
          :style="{ left: `${content.left}px`, top: `${content.top}px` }"
          :board="activeBoard"
          :tool="tool"
          :color="color"
          :size="size"
          :polyline-arrow="polylineArrow"
          :width="content.width"
          :height="content.height"
        />
        <div class="tools">
          <DrawToolbar
            :tool="tool"
            :color="color"
            :size="size"
            :polyline-arrow="polylineArrow"
            :selected-count="selectedCount"
            pointer-label="远程指针（点击可提示对方）"
            @update:tool="setTool"
            @update:color="color = $event"
            @update:size="size = $event"
            @update:polyline-arrow="polylineArrow = $event"
            @undo="store.undoStroke(activeBoard)"
            @clear="clearAnno"
            @delete-selection="layerRef?.deleteSelection()"
          >
            <template v-if="hasAudio">
              <span class="sep" />
              <button
                class="tool"
                :title="muted ? '播放共享的声音' : '静音'"
                @click="muted = !muted"
              >
                <AppIcon :name="muted ? 'volume-off' : 'volume'" :size="16" />
              </button>
            </template>
          </DrawToolbar>
        </div>
      </template>

      <div v-else-if="store.watching && store.watching !== 'self'" class="empty">
        <AppIcon name="monitor" :size="36" />
        <p>正在建立画面连接…</p>
      </div>

      <div v-else class="empty">
        <AppIcon name="monitor" :size="36" />
        <template v-if="store.status !== 'online' || store.connectedPeers.length === 0">
          <p>先连接设备，再共享屏幕或观看对方画面。</p>
          <button class="ghost" @click="store.setView('network')">去组网</button>
        </template>
        <template v-else>
          <p>还没有人共享屏幕。</p>
          <button v-if="canShare" class="primary" @click="share">
            <AppIcon name="monitor" :size="15" /> 共享我的屏幕
          </button>
          <p v-else class="warn">当前浏览器不支持屏幕采集（移动端普遍不支持），但可以观看他人共享。</p>
        </template>
      </div>
    </div>

    <footer class="note">
      观看端可用「远程指针 / 点击提示 / 画笔批注」实时标注对方画面（对方预览同步可见）。
      受浏览器安全模型限制，网页无法向对方系统注入键鼠，完整远程控制需原生程序。
    </footer>
  </div>
</template>

<style scoped>
.screenpage {
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

.sharebtn,
.danger-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.target-sel {
  font: inherit;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  font-size: 13px;
  cursor: pointer;
}

.danger-btn {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

.danger-btn:hover:not(:disabled) {
  background: var(--danger-fg);
  border-color: var(--danger-fg);
  color: #fff;
}

.tabs {
  display: flex;
  gap: 8px;
  padding: 10px 24px 0;
}

.tab {
  padding: 6px 14px;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  border: 1px solid var(--border);
  border-bottom: none;
  background: var(--panel-2);
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab.on {
  background: var(--stage);
  border-color: var(--stage);
  color: #eceaf6;
}

.pending {
  font-size: 10px;
  color: var(--warn);
}

.stage {
  flex: 1;
  min-height: 0;
  position: relative;
  margin: 0 24px;
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.tabs + .stage {
  border-top-left-radius: 0;
}

.stage video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.overlay {
  position: absolute;
  z-index: 2;
}

.tools {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 4;
}

.tools .sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
}

.tools .tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 7px;
}

.tools .tool:hover {
  background: var(--panel-2);
  color: var(--accent);
}

.empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #8d88a8;
  text-align: center;
  padding: 0 32px;
}

.empty .warn {
  font-size: 12px;
  color: var(--warn);
}

.note {
  padding: 10px 24px 14px;
  font-size: 11px;
  color: var(--muted);
}
</style>
