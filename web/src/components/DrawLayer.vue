<script setup lang="ts">
// 绘制叠加层：铺在视频内容区（屏幕批注）或白板面上，负责
//   1) 按 boardRev 全量重绘该画面的笔画（DPR 感知）；
//   2) 指针输入：pen/eraser 拖动成笔画，pointer 模式点击发涟漪；
//      hover 移动始终节流上报为远程光标；
//   3) 渲染远程成员光标与点击涟漪。
// 坐标一律归一化到本层尺寸（父组件保证本层与内容区对齐）。

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoomStore } from '@/stores/room'
import { renderStrokes } from '@/core/draw'
import type { DrawMode } from '@/core/messages'

const props = defineProps<{
  board: string
  /** pointer=远程指针（默认交互）；pen/eraser=绘制。 */
  tool: 'pointer' | DrawMode
  color: string
  size: number
  width: number
  height: number
}>()

const store = useRoomStore()
const canvasEl = ref<HTMLCanvasElement | null>(null)
const layerEl = ref<HTMLDivElement | null>(null)

// —— 笔画重绘 ——
// 挂载时先按当前状态画一遍：笔画可能早于本层挂载就已同步到达。
onMounted(() => redraw())
watch(
  () => [store.boardRev, props.width, props.height, props.board] as const,
  () => redraw(),
  { flush: 'post' },
)

function redraw(): void {
  const canvas = canvasEl.value
  if (!canvas || props.width <= 0 || props.height <= 0) return
  const dpr = window.devicePixelRatio || 1
  const pw = Math.round(props.width * dpr)
  const ph = Math.round(props.height * dpr)
  if (canvas.width !== pw) canvas.width = pw
  if (canvas.height !== ph) canvas.height = ph
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  renderStrokes(ctx, store.getBoard(props.board), props.width, props.height)
}

// —— 输入 ——
let drawingId: string | null = null
let pendingPts: number[] = []
let flushTimer: number | null = null
let lastPtrSent = 0

function norm(ev: PointerEvent): { x: number; y: number } | null {
  const el = layerEl.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
  const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height))
  return { x, y }
}

function onPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0) return
  const p = norm(ev)
  if (!p) return
  layerEl.value?.setPointerCapture(ev.pointerId)
  if (props.tool === 'pointer') {
    store.sendClick(props.board, p.x, p.y)
    return
  }
  drawingId = store.beginStroke(props.board, props.tool, props.color, props.size, p.x, p.y)
}

function onPointerMove(ev: PointerEvent): void {
  const p = norm(ev)
  if (!p) return
  if (drawingId) {
    pendingPts.push(p.x, p.y)
    if (flushTimer === null) {
      flushTimer = window.setTimeout(flushPoints, 40)
    }
  }
  // 无论何种工具，hover/拖动位置都作为远程光标节流上报。
  const now = Date.now()
  if (now - lastPtrSent > 50) {
    lastPtrSent = now
    store.sendPointer(props.board, p.x, p.y)
  }
}

function flushPoints(): void {
  flushTimer = null
  if (drawingId && pendingPts.length > 0) {
    store.extendStroke(props.board, drawingId, pendingPts)
    pendingPts = []
  }
}

function onPointerUp(): void {
  if (!drawingId) return
  flushPoints()
  store.endStroke(props.board, drawingId)
  drawingId = null
}

function onPointerLeave(): void {
  store.hidePointer(props.board)
}

onBeforeUnmount(() => {
  onPointerUp()
  store.hidePointer(props.board)
  if (flushTimer !== null) window.clearTimeout(flushTimer)
})

// —— 远程光标 / 点击涟漪 ——
/** 每个远端节点的最近轨迹点（最多保留 TRAIL_LEN 个）。 */
const TRAIL_LEN = 18
const trails = reactive(new Map<string, { x: number; y: number }[]>())

const remotePointers = computed(() => {
  const prefix = `${props.board}|`
  const out: { key: string; x: number; y: number; color: string; nick: string }[] = []
  for (const [key, p] of store.pointers) {
    if (!key.startsWith(prefix)) continue
    out.push({
      key,
      x: p.x,
      y: p.y,
      color: p.color,
      nick: store.displayName(p.peerId),
    })
  }
  return out
})

watch(remotePointers, (cur) => {
  for (const p of cur) {
    const pts = trails.get(p.key) ?? []
    pts.push({ x: p.x, y: p.y })
    if (pts.length > TRAIL_LEN) pts.splice(0, pts.length - TRAIL_LEN)
    trails.set(p.key, pts)
  }
  // 清理已离开的光标。
  for (const key of trails.keys()) {
    if (!cur.some((p) => p.key === key)) trails.delete(key)
  }
})

const boardClicks = computed(() => store.clicks.filter((c) => c.board === props.board))

const cursorStyle = computed(() =>
  props.tool === 'pointer' ? 'default' : 'crosshair',
)
</script>

<template>
  <div
    ref="layerEl"
    class="drawlayer"
    :style="{ width: `${width}px`, height: `${height}px`, cursor: cursorStyle }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerleave="onPointerLeave"
  >
    <canvas ref="canvasEl" class="strokes" :style="{ width: `${width}px`, height: `${height}px` }" />

    <!-- 远端鼠标轨迹尾迹（SVG 渐隐线段） -->
    <svg class="trail-layer" :style="{ width: `${width}px`, height: `${height}px` }">
      <template v-for="p in remotePointers" :key="p.key + '-trail'">
        <line
          v-for="(pt, i) in (trails.get(p.key) ?? []).slice(0, -1)"
          :key="i"
          :x1="pt.x * width"
          :y1="pt.y * height"
          :x2="(trails.get(p.key)![i + 1].x) * width"
          :y2="(trails.get(p.key)![i + 1].y) * height"
          :stroke="p.color"
          :stroke-width="2.5"
          :stroke-opacity="(i + 1) / TRAIL_LEN * 0.7"
          stroke-linecap="round"
        />
      </template>
    </svg>

    <div
      v-for="p in remotePointers"
      :key="p.key"
      class="cursor"
      :style="{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" :fill="p.color">
        <path d="M4 2l16 7.5-7 2-3.5 6.5z" stroke="#fff" stroke-width="1.6" />
      </svg>
      <span class="tag" :style="{ background: p.color }">{{ p.nick }}</span>
    </div>

    <span
      v-for="c in boardClicks"
      :key="c.id"
      class="ripple"
      :style="{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, borderColor: c.color }"
    />
  </div>
</template>

<style scoped>
.drawlayer {
  position: relative;
  touch-action: none;
  user-select: none;
  overflow: hidden;
}

.strokes {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.trail-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
}

.cursor {
  position: absolute;
  pointer-events: none;
  transform: translate(-2px, -2px);
  display: flex;
  align-items: flex-start;
  gap: 2px;
  z-index: 3;
  transition: left 0.05s linear, top 0.05s linear;
}

.cursor .tag {
  margin-top: 12px;
  color: #fff;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 4px;
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ripple {
  position: absolute;
  pointer-events: none;
  width: 36px;
  height: 36px;
  margin: -18px 0 0 -18px;
  border: 3px solid;
  border-radius: 50%;
  z-index: 2;
  animation: ripple 1.1s ease-out forwards;
}

@keyframes ripple {
  from {
    transform: scale(0.25);
    opacity: 0.95;
  }
  to {
    transform: scale(1.4);
    opacity: 0;
  }
}
</style>
