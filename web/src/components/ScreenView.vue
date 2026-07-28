<script setup lang="ts">
// 屏幕共享：本端 getDisplayMedia 采集 → 媒体轨经各对端连接直传；
// 观看端在视频上叠加 DrawLayer——远程指针 / 点击提示 / 透明画笔批注，
// 同样的叠加也渲染在共享端预览上，形成「远程指挥」闭环。
// 多人共享时支持三种视图：单画面（页签切换）/ 并列一行 / 平铺网格。
// 注：浏览器安全模型不允许网页向对端操作系统注入键鼠事件（Captured
// Surface Control 亦仅转发本机可信事件），故不存在纯浏览器的完整远控。

import { computed, ref, shallowReactive } from 'vue'
import { useRoomStore } from '@/stores/room'
import type { DrawMode } from '@/core/messages'
import AppIcon from './AppIcon.vue'
import DrawToolbar from './DrawToolbar.vue'
import ScreenTile from './ScreenTile.vue'

const store = useRoomStore()

// —— 工具状态 ——
const tool = ref<'pointer' | DrawMode>('pointer')
const color = ref('#e5484d')
const size = ref(6)
const muted = ref(true)
const polylineArrow = ref(false)

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

function streamOf(id: string): MediaStream | null {
  return id === 'self' ? store.localScreen : (store.remoteScreens.get(id) ?? null)
}

function boardOf(id: string): string {
  return `screen:${id === 'self' ? store.myId : id}`
}

// —— 视图布局 ——
// focus=单画面（页签切换）；split=并列一行；grid=平铺网格。
const layout = ref<'focus' | 'split' | 'grid'>('focus')
const effLayout = computed(() => (feeds.value.length > 1 ? layout.value : 'focus'))

/** 平铺列数：并列一行铺开；网格取接近正方形的列数。 */
const tileCols = computed(() => {
  const n = feeds.value.length
  return effLayout.value === 'split' ? n : Math.ceil(Math.sqrt(n))
})

/** 从多画面点「放大」回到单画面焦点视图。 */
function focusFeed(id: string): void {
  store.watching = id
  layout.value = 'focus'
}

const activeStream = computed<MediaStream | null>(() =>
  store.watching ? streamOf(store.watching) : null,
)

/** 多画面下工具条作用的那一路：最近指针经过的，缺省第一路。 */
const activeFeedId = ref<string | null>(null)
const multiActiveId = computed<string | null>(() => {
  const id = activeFeedId.value
  if (id && feeds.value.some((f) => f.id === id)) return id
  return feeds.value[0]?.id ?? null
})

/** 撤销 / 清空 / 删除选中作用的批注层 board id。 */
const activeBoard = computed(() =>
  effLayout.value === 'focus'
    ? boardOf(store.watching ?? '')
    : boardOf(multiActiveId.value ?? ''),
)

// —— 画面实例引用（选中数 / 删除选中要透传到对应那一路的 DrawLayer）——
const tileRefs = shallowReactive(new Map<string, InstanceType<typeof ScreenTile>>())

function setTileRef(id: string, el: unknown): void {
  if (el) tileRefs.set(id, el as InstanceType<typeof ScreenTile>)
  else tileRefs.delete(id)
}

const activeTileKey = computed(() =>
  effLayout.value === 'focus' ? 'focus' : multiActiveId.value,
)

const selectedCount = computed(() =>
  activeTileKey.value ? (tileRefs.get(activeTileKey.value)?.selectedCount ?? 0) : 0,
)

function deleteSelection(): void {
  if (activeTileKey.value) tileRefs.get(activeTileKey.value)?.deleteSelection()
}

const hasAudio = computed(() => {
  if (effLayout.value === 'focus') {
    return store.watching !== 'self' && (activeStream.value?.getAudioTracks().length ?? 0) > 0
  }
  return feeds.value.some(
    (f) => f.id !== 'self' && (store.remoteScreens.get(f.id)?.getAudioTracks().length ?? 0) > 0,
  )
})

/** 工具条何时显示：焦点模式有画面 / 多画面至少一路已就绪。 */
const toolsVisible = computed(() =>
  effLayout.value === 'focus'
    ? activeStream.value !== null
    : feeds.value.some((f) => streamOf(f.id) !== null),
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

const canShare = computed(
  () => store.capabilities.displayMedia && store.status === 'online' && store.screenReach.ok > 0,
)

/** 按钮禁用时的原因，避免用户点了没反应又不知为何。 */
const shareHint = computed(() => {
  if (!store.capabilities.displayMedia) return '当前浏览器不支持屏幕采集（需 https 且为桌面端）'
  if (store.status !== 'online') return '请先连接设备'
  if (store.screenReach.total === 0) return '还没有已连接的节点'
  if (store.screenReach.ok === 0) {
    return '已连接的节点都走服务器中继，该路径需要 WebCodecs 编码画面，当前浏览器不支持'
  }
  return ''
})
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
        <button
          class="primary sharebtn"
          :disabled="!canShare"
          :title="shareHint"
          @click="share"
        >
          <AppIcon name="monitor" :size="15" /> 共享我的屏幕
        </button>
      </template>
    </header>

    <div v-if="feeds.length > 1" class="viewbar">
      <div v-if="effLayout === 'focus'" class="tabs">
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
      <span v-else class="feedcount">{{ feeds.length }} 路画面</span>
      <div class="layouts">
        <button
          class="lay"
          :class="{ on: effLayout === 'focus' }"
          title="单画面（页签切换）"
          @click="layout = 'focus'"
        >
          <AppIcon name="layout-focus" :size="15" />
        </button>
        <button
          class="lay"
          :class="{ on: effLayout === 'split' }"
          title="并列"
          @click="layout = 'split'"
        >
          <AppIcon name="layout-split" :size="15" />
        </button>
        <button
          class="lay"
          :class="{ on: effLayout === 'grid' }"
          title="平铺"
          @click="layout = 'grid'"
        >
          <AppIcon name="layout-grid" :size="15" />
        </button>
      </div>
    </div>

    <div class="stage" :class="{ multi: effLayout !== 'focus' }">
      <template v-if="effLayout === 'focus'">
        <ScreenTile
          v-if="activeStream"
          :ref="(el) => setTileRef('focus', el)"
          class="focus-tile"
          :stream="activeStream"
          :board="activeBoard"
          :tool="tool"
          :color="color"
          :size="size"
          :polyline-arrow="polylineArrow"
          :muted="store.watching === 'self' || muted"
        />

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
      </template>

      <div
        v-else
        class="tiles"
        :style="{ gridTemplateColumns: `repeat(${tileCols}, minmax(0, 1fr))` }"
      >
        <div
          v-for="f in feeds"
          :key="f.id"
          class="cell"
          @pointerenter="activeFeedId = f.id"
        >
          <div class="cell-head">
            <span class="dot" :class="{ live: f.live }" />
            <span class="cell-label">{{ f.label }}</span>
            <button class="cell-btn" title="放大到单画面" @click="focusFeed(f.id)">
              <AppIcon name="expand" :size="13" />
            </button>
          </div>
          <div class="cell-body">
            <ScreenTile
              v-if="streamOf(f.id)"
              :ref="(el) => setTileRef(f.id, el)"
              :stream="streamOf(f.id)!"
              :board="boardOf(f.id)"
              :tool="tool"
              :color="color"
              :size="size"
              :polyline-arrow="polylineArrow"
              :muted="f.id === 'self' || muted"
            />
            <div v-else class="cell-empty">
              <AppIcon name="monitor" :size="22" />
              <span>连接中…</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="toolsVisible" class="tools">
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
          @delete-selection="deleteSelection"
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

.viewbar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 10px 24px 0;
}

.tabs {
  flex: 1;
  display: flex;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
}

.feedcount {
  flex: 1;
  font-size: 12px;
  color: var(--muted);
  padding-bottom: 7px;
}

.layouts {
  display: flex;
  gap: 2px;
  padding: 2px;
  margin-bottom: 5px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.lay {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 5px;
  color: var(--muted);
}

.lay:hover {
  color: var(--text);
}

.lay.on {
  background: var(--panel);
  color: var(--accent);
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
  white-space: nowrap;
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

.viewbar + .stage {
  border-top-left-radius: 0;
}

.focus-tile {
  position: absolute;
  inset: 0;
}

.tiles {
  position: absolute;
  inset: 0;
  display: grid;
  grid-auto-rows: minmax(0, 1fr);
  gap: 10px;
  padding: 10px;
}

.cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.cell-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: #cfcbe0;
  background: rgb(255 255 255 / 7%);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warn);
  flex: none;
}

.dot.live {
  background: #2ecc71;
}

.cell-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  background: transparent;
  color: inherit;
  border-radius: 4px;
}

.cell-btn:hover {
  background: rgb(255 255 255 / 12%);
}

.cell-body {
  flex: 1;
  min-height: 0;
  position: relative;
}

.cell-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #8d88a8;
  font-size: 12px;
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
