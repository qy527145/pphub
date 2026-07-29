<script lang="ts">
// 同屏可能挂多层（屏幕共享多画面平铺），模块级计数用于粘贴归属判定。
let mountedLayers = 0
</script>

<script setup lang="ts">
// 绘制叠加层：铺在视频内容区（屏幕批注）或白板面上，负责
//   1) 按 boardRev 全量重绘该画面的元素（DPR 感知）；
//   2) 指针输入：pen/eraser 拖动成笔画，line/arrow/text/image 点击交互，pointer 模式点击发涟漪；
//      hover 移动始终节流上报为远程光标；
//   3) 渲染远程成员光标与点击涟漪。
// 坐标一律归一化到本层尺寸（父组件保证本层与内容区对齐）。

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoomStore } from '@/stores/room'
import {
  renderStrokes,
  setImageReadyHandler,
  itemBounds,
  itemHitByCircle,
  itemIntersectsRect,
  normalizeRect,
  LOGICAL_WIDTH,
} from '@/core/draw'
import type { DrawMode, WbImage } from '@/core/messages'
import AppIcon from './AppIcon.vue'

const props = withDefaults(
  defineProps<{
    board: string
    /** pointer=远程指针（默认交互）；pen/eraser=绘制；其余为形状/框选工具。 */
    tool: 'pointer' | DrawMode
    color: string
    size: number
    width: number
    height: number
    /** 折线是否在末段加箭头。 */
    polylineArrow?: boolean
  }>(),
  { polylineArrow: false },
)

const store = useRoomStore()
const canvasEl = ref<HTMLCanvasElement | null>(null)
const layerEl = ref<HTMLDivElement | null>(null)

// —— 笔画重绘 ——
// 挂载时先按当前状态画一遍：笔画可能早于本层挂载就已同步到达。
onMounted(() => {
  mountedLayers++
  redraw()
  // 贴图解码是异步的，解码完成后需要重绘本层
  setImageReadyHandler(() => redraw())
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('paste', onPaste)
})
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
let shapeStart: { x: number; y: number } | null = null
const previewShape = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

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

  if (props.tool === 'select') {
    // 裁剪进行中：只响应裁剪手柄/按钮（它们自带 stop），空白点击不打断
    if (cropMode.value) return
    // 点在已选包围盒内 → 拖动整组；点中图片 → 单图变换；否则拉框选
    const box = selectionBox.value
    if (
      box &&
      p.x >= box.x1 - 0.005 &&
      p.x <= box.x2 + 0.005 &&
      p.y >= box.y1 - 0.005 &&
      p.y <= box.y2 + 0.005
    ) {
      groupMove = { last: p }
      return
    }
    const img = imageAt(p)
    if (img) {
      selectedIds.value = [img.id]
      beginXform(img, 'move', p)
      return
    }
    shapeStart = p
    previewShape.value = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }
    return
  }

  if (
    props.tool === 'line' ||
    props.tool === 'arrow' ||
    props.tool === 'rect' ||
    props.tool === 'ellipse'
  ) {
    shapeStart = p
    previewShape.value = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }
    return
  }

  if (props.tool === 'polyline') {
    addPolyVertex(p)
    return
  }

  if (props.tool === 'text') {
    promptText(p.x, p.y)
    return
  }

  if (props.tool === 'image') {
    selectImage(p.x, p.y)
    return
  }

  if (props.tool === 'eraser') {
    erasing = true
    eraseAt(p)
    return
  }

  if (props.tool === 'pen') {
    drawingId = store.beginStroke(props.board, 'pen', props.color, props.size, p.x, p.y)
  }
}

// —— 对象橡皮 ——
// 旧实现是 destination-out 像素抠除：每次都要新建一条橡皮笔画并全量重绘，
// 擦大面积时消息量和重绘成本都很高。改为按命中直接删除元素。
let erasing = false

function eraseAt(p: { x: number; y: number }): void {
  const items = store.getBoard(props.board)
  if (items.length === 0) return
  const radius = props.size / 2 / LOGICAL_WIDTH
  const aspect = props.width > 0 ? props.height / props.width : 1
  const hit: string[] = []
  for (const it of items) {
    if (itemHitByCircle(it, p.x, p.y, radius, aspect)) hit.push(it.id)
  }
  if (hit.length > 0) store.removeItems(props.board, hit)
}

// —— 折线 ——
// 逐点点击成段，双击 / Enter / Esc 收尾。
const polyPoints = ref<number[]>([])
const polyCursor = ref<{ x: number; y: number } | null>(null)

function addPolyVertex(p: { x: number; y: number }): void {
  polyPoints.value.push(p.x, p.y)
  polyCursor.value = { x: p.x, y: p.y }
}

function finishPolyline(): void {
  const pts = polyPoints.value
  if (pts.length >= 4) {
    store.addPolyline(props.board, props.color, props.size, pts, props.polylineArrow)
  }
  polyPoints.value = []
  polyCursor.value = null
}

function cancelPolyline(): void {
  polyPoints.value = []
  polyCursor.value = null
}

function onKeyDown(ev: KeyboardEvent): void {
  if (polyPoints.value.length > 0) {
    if (ev.key === 'Enter') finishPolyline()
    else if (ev.key === 'Escape') cancelPolyline()
    return
  }
  if (props.tool === 'select') {
    if (cropMode.value) {
      if (ev.key === 'Escape') cancelCrop()
      else if (ev.key === 'Enter') applyCrop()
      return
    }
    if (selectedIds.value.length > 0) {
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault()
        deleteSelection()
      } else if (ev.key === 'Escape') {
        selectedIds.value = []
      }
    }
  }
}

// —— 框选 ——
const selectedIds = ref<string[]>([])

const selectionBox = computed(() => {
  // 元素本体不做响应式（room store 约定），读 boardRev 让包围盒跟随拖动/远端更新
  void store.boardRev
  if (selectedIds.value.length === 0) return null
  const keep = new Set(selectedIds.value)
  const items = store.getBoard(props.board).filter((i) => keep.has(i.id))
  if (items.length === 0) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const it of items) {
    const b = itemBounds(it)
    x1 = Math.min(x1, b.x1)
    y1 = Math.min(y1, b.y1)
    x2 = Math.max(x2, b.x2)
    y2 = Math.max(y2, b.y2)
  }
  return { x1, y1, x2, y2 }
})

function applySelection(rect: { x1: number; y1: number; x2: number; y2: number }): void {
  const r = normalizeRect(rect)
  // 近似零面积视作空击，清空选区
  if (r.x2 - r.x1 < 0.002 && r.y2 - r.y1 < 0.002) {
    selectedIds.value = []
    return
  }
  selectedIds.value = store
    .getBoard(props.board)
    .filter((it) => itemIntersectsRect(it, r))
    .map((it) => it.id)
}

function deleteSelection(): void {
  if (selectedIds.value.length === 0) return
  cancelCrop()
  store.removeItems(props.board, selectedIds.value)
  selectedIds.value = []
}

// —— 图片变换（select 工具）：拖动 / 旋转 / 缩放 ——
// 旋转/缩放都以图片中心为锚点；角度与距离在 aspect 折算空间计算，
// 与像素空间的渲染旋转保持角度一致。
interface XformState {
  type: 'move' | 'scale' | 'rotate'
  id: string
  startX: number
  startY: number
  orig: { x: number; y: number; width: number; height: number; rotation: number }
}
let xform: XformState | null = null

/** 框选整组拖动状态（增量平移，网络端由 store 限流）。 */
let groupMove: { last: { x: number; y: number } } | null = null

const aspect = computed(() => (props.width > 0 ? props.height / props.width : 1))

/** 命中最上层的图片（旋转感知）。 */
function imageAt(p: { x: number; y: number }): WbImage | null {
  const items = store.getBoard(props.board)
  const a = aspect.value
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.mode !== 'image') continue
    const cx = it.x + it.width / 2
    const cyS = (it.y + it.height / 2) * a
    const dx = p.x - cx
    const dy = p.y * a - cyS
    const rot = it.rotation ?? 0
    const cos = Math.cos(-rot)
    const sin = Math.sin(-rot)
    const lx = dx * cos - dy * sin
    const ly = dx * sin + dy * cos
    if (Math.abs(lx) <= it.width / 2 && Math.abs(ly) <= (it.height / 2) * a) return it
  }
  return null
}

/** 唯一选中且是图片时才显示变换手柄。 */
const activeImage = computed<WbImage | null>(() => {
  void store.boardRev
  if (props.tool !== 'select' || selectedIds.value.length !== 1) return null
  const it = store.getBoard(props.board).find((i) => i.id === selectedIds.value[0])
  return it && it.mode === 'image' ? it : null
})

const xformStyle = computed(() => {
  // 拖动中元素被就地改写，靠 boardRev 让手柄框跟随
  void store.boardRev
  const img = activeImage.value
  if (!img) return {}
  return {
    left: `${img.x * props.width}px`,
    top: `${img.y * props.height}px`,
    width: `${img.width * props.width}px`,
    height: `${img.height * props.height}px`,
    transform: `rotate(${img.rotation ?? 0}rad)`,
  }
})

function beginXform(img: WbImage, type: XformState['type'], p: { x: number; y: number }): void {
  xform = {
    type,
    id: img.id,
    startX: p.x,
    startY: p.y,
    orig: {
      x: img.x,
      y: img.y,
      width: img.width,
      height: img.height,
      rotation: img.rotation ?? 0,
    },
  }
}

function startHandle(ev: PointerEvent, type: 'scale' | 'rotate'): void {
  const img = activeImage.value
  const p = norm(ev)
  if (!img || !p) return
  layerEl.value?.setPointerCapture(ev.pointerId)
  beginXform(img, type, p)
}

function applyXform(p: { x: number; y: number }): void {
  if (!xform) return
  const o = xform.orig
  if (xform.type === 'move') {
    store.updateImage(props.board, xform.id, {
      x: o.x + (p.x - xform.startX),
      y: o.y + (p.y - xform.startY),
      width: o.width,
      height: o.height,
      rotation: o.rotation,
    })
    return
  }
  const a = aspect.value
  const cx = o.x + o.width / 2
  const cy = o.y + o.height / 2
  const dx = p.x - cx
  const dy = (p.y - cy) * a
  const sdx = xform.startX - cx
  const sdy = (xform.startY - cy) * a
  if (xform.type === 'scale') {
    const d0 = Math.hypot(sdx, sdy)
    if (d0 <= 0) return
    const k = Math.max(0.15, Math.hypot(dx, dy) / d0)
    const w = o.width * k
    const h = o.height * k
    store.updateImage(props.board, xform.id, {
      x: cx - w / 2,
      y: cy - h / 2,
      width: w,
      height: h,
      rotation: o.rotation,
    })
    return
  }
  store.updateImage(props.board, xform.id, {
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    rotation: o.rotation + (Math.atan2(dy, dx) - Math.atan2(sdy, sdx)),
  })
}

function endXform(): void {
  const xf = xform
  if (!xf) return
  xform = null
  const it = store.getBoard(props.board).find((i) => i.id === xf.id)
  if (it && it.mode === 'image') {
    store.updateImage(
      props.board,
      xf.id,
      { x: it.x, y: it.y, width: it.width, height: it.height, rotation: it.rotation },
      true,
    )
  }
}

// —— 图片裁剪（select 工具，选中单张图片后进入）——
// 裁剪框以图片本地 [0,1] 分数坐标表示，随图片一起旋转显示；
// 确认时把源图子区域重编码为新元素（删旧加新，两条消息均已有同步语义）。
const cropMode = ref(false)
const cropRect = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
let cropDrag: 'nw' | 'ne' | 'sw' | 'se' | null = null

function startCrop(): void {
  if (!activeImage.value) return
  cropMode.value = true
  cropRect.value = { x1: 0, y1: 0, x2: 1, y2: 1 }
}

function cancelCrop(): void {
  cropMode.value = false
  cropRect.value = null
  cropDrag = null
}

/** 把层归一化坐标换算到图片本地 [0,1] 分数坐标（旋转感知）。 */
function toLocalFrac(p: { x: number; y: number }, img: WbImage): { fx: number; fy: number } {
  const a = aspect.value
  const cx = img.x + img.width / 2
  const cyS = (img.y + img.height / 2) * a
  const dx = p.x - cx
  const dy = p.y * a - cyS
  const rot = img.rotation ?? 0
  const cos = Math.cos(-rot)
  const sin = Math.sin(-rot)
  const lx = dx * cos - dy * sin
  const ly = (dx * sin + dy * cos) / a
  return { fx: lx / img.width + 0.5, fy: ly / img.height + 0.5 }
}

function startCropHandle(ev: PointerEvent, corner: 'nw' | 'ne' | 'sw' | 'se'): void {
  layerEl.value?.setPointerCapture(ev.pointerId)
  cropDrag = corner
}

function applyCropDrag(p: { x: number; y: number }): void {
  const img = activeImage.value
  const r = cropRect.value
  if (!img || !r || !cropDrag) return
  const { fx, fy } = toLocalFrac(p, img)
  const cfx = Math.min(1, Math.max(0, fx))
  const cfy = Math.min(1, Math.max(0, fy))
  if (cropDrag === 'nw' || cropDrag === 'sw') r.x1 = Math.min(cfx, r.x2 - 0.05)
  else r.x2 = Math.max(cfx, r.x1 + 0.05)
  if (cropDrag === 'nw' || cropDrag === 'ne') r.y1 = Math.min(cfy, r.y2 - 0.05)
  else r.y2 = Math.max(cfy, r.y1 + 0.05)
}

function applyCrop(): void {
  const img = activeImage.value
  const r = cropRect.value
  if (!img || !r) return
  const fx = Math.min(r.x1, r.x2)
  const fy = Math.min(r.y1, r.y2)
  const fw = Math.abs(r.x2 - r.x1)
  const fh = Math.abs(r.y2 - r.y1)
  cancelCrop()
  if (fw >= 0.995 && fh >= 0.995) return
  const src = new Image()
  src.onload = () => {
    const sw = Math.max(1, Math.round(src.naturalWidth * fw))
    const sh = Math.max(1, Math.round(src.naturalHeight * fh))
    const off = document.createElement('canvas')
    off.width = sw
    off.height = sh
    const octx = off.getContext('2d')
    if (!octx) return
    octx.drawImage(src, src.naturalWidth * fx, src.naturalHeight * fy, sw, sh, 0, 0, sw, sh)
    let dataUrl = off.toDataURL('image/jpeg', 0.8)
    for (let q = 0.6; dataUrl.length > IMG_MAX_BYTES && q >= 0.3; q -= 0.15) {
      dataUrl = off.toDataURL('image/jpeg', q)
    }
    // 裁剪中心的本地偏移旋转回世界系（旋转发生在像素空间，y 按 aspect 折算）
    const rot = img.rotation ?? 0
    const a = aspect.value
    const ox = (fx + fw / 2 - 0.5) * img.width
    const oy = (fy + fh / 2 - 0.5) * img.height
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const ncx = img.x + img.width / 2 + (ox * cos - oy * a * sin)
    const ncy = img.y + img.height / 2 + ((ox / a) * sin + oy * cos)
    const nw = img.width * fw
    const nh = img.height * fh
    store.removeItems(props.board, [img.id])
    const id = store.addImage(props.board, ncx - nw / 2, ncy - nh / 2, nw, nh, dataUrl)
    if (rot) {
      store.updateImage(
        props.board,
        id,
        { x: ncx - nw / 2, y: ncy - nh / 2, width: nw, height: nh, rotation: rot },
        true,
      )
    }
    selectedIds.value = [id]
  }
  src.src = img.dataUrl
}

const cropBoxStyle = computed(() => {
  const r = cropRect.value
  if (!r) return {}
  return {
    left: `${Math.min(r.x1, r.x2) * 100}%`,
    top: `${Math.min(r.y1, r.y2) * 100}%`,
    width: `${Math.abs(r.x2 - r.x1) * 100}%`,
    height: `${Math.abs(r.y2 - r.y1) * 100}%`,
  }
})

function cropHandleStyle(c: 'nw' | 'ne' | 'sw' | 'se'): Record<string, string> {
  const r = cropRect.value
  if (!r) return {}
  const x = c === 'nw' || c === 'sw' ? Math.min(r.x1, r.x2) : Math.max(r.x1, r.x2)
  const y = c === 'nw' || c === 'ne' ? Math.min(r.y1, r.y2) : Math.max(r.y1, r.y2)
  return { left: `${x * 100}%`, top: `${y * 100}%` }
}

// 被裁剪的图片若被删除（本端撤销/远端擦除），退出裁剪态
watch(activeImage, (img) => {
  if (!img) cancelCrop()
})

function onPointerMove(ev: PointerEvent): void {
  const p = norm(ev)
  if (!p) return
  lastPos = p
  pointerInside = true

  if (cropDrag) {
    applyCropDrag(p)
    return
  }

  if (xform) {
    applyXform(p)
    return
  }

  if (groupMove) {
    store.moveItems(props.board, selectedIds.value, p.x - groupMove.last.x, p.y - groupMove.last.y)
    groupMove.last = p
    return
  }

  if (shapeStart && previewShape.value) {
    previewShape.value.x2 = p.x
    previewShape.value.y2 = p.y
  }

  if (props.tool === 'eraser') hoverPos.value = { x: p.x, y: p.y }

  if (polyPoints.value.length > 0) polyCursor.value = { x: p.x, y: p.y }

  if (erasing) eraseAt(p)

  if (drawingId) {
    pendingPts.push(p.x, p.y)
    if (flushTimer === null) {
      flushTimer = window.setTimeout(flushPoints, 40)
    }
  }

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
  erasing = false

  if (cropDrag) {
    cropDrag = null
    return
  }

  if (xform) {
    endXform()
    return
  }

  if (groupMove) {
    groupMove = null
    store.moveItems(props.board, selectedIds.value, 0, 0, true)
    return
  }

  if (shapeStart && previewShape.value) {
    const box = previewShape.value
    if (props.tool === 'select') {
      applySelection(box)
    } else {
      store.addLine(
        props.board,
        props.tool as 'line' | 'arrow' | 'rect' | 'ellipse',
        props.color,
        props.size,
        box.x1,
        box.y1,
        box.x2,
        box.y2,
      )
    }
    shapeStart = null
    previewShape.value = null
  }

  if (!drawingId) return
  flushPoints()
  store.endStroke(props.board, drawingId)
  drawingId = null
}

function promptText(x: number, y: number): void {
  const text = window.prompt('输入文本：')
  if (text && text.trim()) {
    store.addText(props.board, props.color, x, y, text.trim(), props.size)
  }
}

// 贴图要走 control 通道（单条 JSON，不分片），必须先压到 SCTP 单消息可承载的体积
const IMG_MAX_PX = 720
const IMG_MAX_BYTES = 48 * 1024

/** 压缩并插入一张图片；centered=true 时 (x,y) 为图片中心（粘贴场景）。 */
function insertImageFile(file: Blob, x: number, y: number, centered = false): void {
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    const scale = Math.min(1, IMG_MAX_PX / Math.max(img.width, img.height))
    const cw = Math.max(1, Math.round(img.width * scale))
    const ch = Math.max(1, Math.round(img.height * scale))
    const off = document.createElement('canvas')
    off.width = cw
    off.height = ch
    const octx = off.getContext('2d')
    URL.revokeObjectURL(url)
    if (!octx) return
    octx.drawImage(img, 0, 0, cw, ch)

    let dataUrl = off.toDataURL('image/jpeg', 0.8)
    for (let q = 0.6; dataUrl.length > IMG_MAX_BYTES && q >= 0.3; q -= 0.15) {
      dataUrl = off.toDataURL('image/jpeg', q)
    }
    if (dataUrl.length > IMG_MAX_BYTES) {
      window.alert('图片太大，请换一张更小的图片')
      return
    }

    const ratio = cw / ch
    let w = 0.3
    let h = w / ratio
    if (h > 0.3) {
      h = 0.3
      w = h * ratio
    }
    const px = centered ? Math.min(Math.max(x - w / 2, 0), Math.max(0, 1 - w)) : x
    const py = centered ? Math.min(Math.max(y - h / 2, 0), Math.max(0, 1 - h)) : y
    store.addImage(props.board, px, py, w, h, dataUrl)
  }
  img.onerror = () => URL.revokeObjectURL(url)
  img.src = url
}

function selectImage(x: number, y: number): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) insertImageFile(file, x, y)
  }
  input.click()
}

// —— 粘贴贴图 ——
// 任意工具下 Ctrl/Cmd+V 剪贴板图片直接落图，跟随最近的指针位置（没有则居中）。
// 同屏多层时（多画面平铺）只有指针所在的那一层接收粘贴。
let lastPos: { x: number; y: number } | null = null
let pointerInside = false

function onPaste(ev: ClipboardEvent): void {
  const target = ev.target as HTMLElement | null
  if (target?.closest('input, textarea, [contenteditable]')) return
  if (mountedLayers > 1 && !pointerInside) return
  const items = ev.clipboardData?.items
  if (!items) return
  for (const it of items) {
    if (!it.type.startsWith('image/')) continue
    const file = it.getAsFile()
    if (file) {
      ev.preventDefault()
      const at = lastPos ?? { x: 0.5, y: 0.5 }
      insertImageFile(file, at.x, at.y, true)
    }
    return
  }
}

function onPointerLeave(): void {
  pointerInside = false
  hoverPos.value = null
  store.hidePointer(props.board)
}

function onDblClick(): void {
  if (polyPoints.value.length > 0) finishPolyline()
}

defineExpose({
  selectedCount: computed(() => selectedIds.value.length),
  deleteSelection,
})

onBeforeUnmount(() => {
  mountedLayers--
  onPointerUp()
  store.hidePointer(props.board)
  if (flushTimer !== null) window.clearTimeout(flushTimer)
  shapeStart = null
  previewShape.value = null
  cancelPolyline()
  selectedIds.value = []
  setImageReadyHandler(null)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('paste', onPaste)
})

// 切换工具时收掉未完成的折线与选区，避免残留预览
watch(
  () => props.tool,
  () => {
    cancelPolyline()
    cancelCrop()
    selectedIds.value = []
    xform = null
    groupMove = null
  },
)

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

const cursorStyle = computed(() => {
  if (props.tool === 'pointer') return 'default'
  if (props.tool === 'text') return 'text'
  if (props.tool === 'image') return 'copy'
  if (props.tool === 'eraser') return 'none'
  return 'crosshair'
})

/** 橡皮光圈直径（屏幕像素），让用户看清擦除范围。 */
const eraserPx = computed(() => (props.size * props.width) / LOGICAL_WIDTH)
const hoverPos = ref<{ x: number; y: number } | null>(null)

/** 折线预览：已落点 + 当前光标位置构成的 SVG points。 */
const polyPreviewPoints = computed(() => {
  const pts = polyPoints.value
  const parts: string[] = []
  for (let i = 0; i + 1 < pts.length; i += 2) {
    parts.push(`${pts[i] * props.width},${pts[i + 1] * props.height}`)
  }
  if (polyCursor.value) {
    parts.push(`${polyCursor.value.x * props.width},${polyCursor.value.y * props.height}`)
  }
  return parts.join(' ')
})

// 计算箭头三角形的顶点
function getArrowPoints(): string {
  if (!previewShape.value) return ''
  const x1 = previewShape.value.x1 * props.width
  const y1 = previewShape.value.y1 * props.height
  const x2 = previewShape.value.x2 * props.width
  const y2 = previewShape.value.y2 * props.height
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const arrowLen = Math.min(30, Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) * 0.3)
  const arrowAngle = Math.PI / 6
  const p1x = x2
  const p1y = y2
  const p2x = x2 - arrowLen * Math.cos(angle - arrowAngle)
  const p2y = y2 - arrowLen * Math.sin(angle - arrowAngle)
  const p3x = x2 - arrowLen * Math.cos(angle + arrowAngle)
  const p3y = y2 - arrowLen * Math.sin(angle + arrowAngle)
  return `${p1x},${p1y} ${p2x},${p2y} ${p3x},${p3y}`
}
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
    @dblclick="onDblClick"
  >
    <canvas ref="canvasEl" class="strokes" :style="{ width: `${width}px`, height: `${height}px` }" />

    <!-- 橡皮光圈：让擦除范围可见 -->
    <div
      v-if="tool === 'eraser' && hoverPos"
      class="eraser-ring"
      :style="{
        left: `${hoverPos.x * width}px`,
        top: `${hoverPos.y * height}px`,
        width: `${eraserPx}px`,
        height: `${eraserPx}px`,
      }"
    />

    <!-- 框选：拖拽中的选框 + 已选中元素的包围盒 -->
    <svg
      v-if="tool === 'select' && (previewShape || selectionBox)"
      class="preview-layer"
      :style="{ width: `${width}px`, height: `${height}px` }"
    >
      <rect
        v-if="previewShape"
        :x="Math.min(previewShape.x1, previewShape.x2) * width"
        :y="Math.min(previewShape.y1, previewShape.y2) * height"
        :width="Math.abs(previewShape.x2 - previewShape.x1) * width"
        :height="Math.abs(previewShape.y2 - previewShape.y1) * height"
        class="marquee"
      />
      <rect
        v-else-if="selectionBox && !activeImage"
        :x="selectionBox.x1 * width - 3"
        :y="selectionBox.y1 * height - 3"
        :width="(selectionBox.x2 - selectionBox.x1) * width + 6"
        :height="(selectionBox.y2 - selectionBox.y1) * height + 6"
        class="selbox"
      />
    </svg>

    <!-- 折线：已落点的线段 + 跟随光标的橡皮筋 -->
    <svg
      v-if="polyPoints.length > 0"
      class="preview-layer"
      :style="{ width: `${width}px`, height: `${height}px` }"
    >
      <polyline
        :points="polyPreviewPoints"
        fill="none"
        :stroke="color"
        :stroke-width="Math.max(1, (size * width) / 1280)"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle
        v-for="(_, i) in polyPoints.length / 2"
        :key="i"
        :cx="polyPoints[i * 2] * width"
        :cy="polyPoints[i * 2 + 1] * height"
        r="3"
        :fill="color"
      />
    </svg>

    <!-- 形状工具预览 -->
    <svg
      v-if="previewShape && (tool === 'line' || tool === 'arrow')"
      class="preview-layer"
      :style="{ width: `${width}px`, height: `${height}px` }"
    >
      <line
        :x1="previewShape.x1 * width"
        :y1="previewShape.y1 * height"
        :x2="previewShape.x2 * width"
        :y2="previewShape.y2 * height"
        :stroke="color"
        :stroke-width="Math.max(1, (size * width) / 1280)"
        stroke-linecap="round"
        stroke-dasharray="5,5"
      />
      <template v-if="tool === 'arrow'">
        <polygon
          :points="getArrowPoints()"
          :fill="color"
          opacity="0.5"
        />
      </template>
    </svg>

    <!-- 矩形/椭圆预览 -->
    <svg
      v-if="previewShape && (tool === 'rect' || tool === 'ellipse')"
      class="preview-layer"
      :style="{ width: `${width}px`, height: `${height}px` }"
    >
      <rect
        v-if="tool === 'rect'"
        :x="Math.min(previewShape.x1, previewShape.x2) * width"
        :y="Math.min(previewShape.y1, previewShape.y2) * height"
        :width="Math.abs(previewShape.x2 - previewShape.x1) * width"
        :height="Math.abs(previewShape.y2 - previewShape.y1) * height"
        fill="none"
        :stroke="color"
        :stroke-width="Math.max(1, (size * width) / 1280)"
        stroke-dasharray="5,5"
      />
      <ellipse
        v-else
        :cx="((previewShape.x1 + previewShape.x2) / 2) * width"
        :cy="((previewShape.y1 + previewShape.y2) / 2) * height"
        :rx="(Math.abs(previewShape.x2 - previewShape.x1) / 2) * width"
        :ry="(Math.abs(previewShape.y2 - previewShape.y1) / 2) * height"
        fill="none"
        :stroke="color"
        :stroke-width="Math.max(1, (size * width) / 1280)"
        stroke-dasharray="5,5"
      />
    </svg>

    <!-- 图片变换手柄：框体拖动、上方旋转、右下角缩放、下方裁剪 -->
    <div v-if="activeImage" class="img-xform" :style="xformStyle">
      <template v-if="!cropMode">
        <span class="rot-line" />
        <span class="handle rot" title="旋转" @pointerdown.stop.prevent="startHandle($event, 'rotate')" />
        <span class="handle scale" title="缩放" @pointerdown.stop.prevent="startHandle($event, 'scale')" />
        <div class="xf-actions">
          <button class="xf-btn" title="裁剪" @pointerdown.stop @click.stop="startCrop">
            <AppIcon name="crop" :size="13" />
          </button>
        </div>
      </template>
      <template v-else-if="cropRect">
        <div class="crop-shade">
          <div class="crop-box" :style="cropBoxStyle" />
        </div>
        <span
          v-for="c in (['nw', 'ne', 'sw', 'se'] as const)"
          :key="c"
          class="handle crop-h"
          :style="cropHandleStyle(c)"
          @pointerdown.stop.prevent="startCropHandle($event, c)"
        />
        <div class="xf-actions">
          <button class="xf-btn ok" title="确认裁剪 (Enter)" @pointerdown.stop @click.stop="applyCrop">
            <AppIcon name="check" :size="13" />
          </button>
          <button class="xf-btn" title="取消 (Esc)" @pointerdown.stop @click.stop="cancelCrop">
            <AppIcon name="x" :size="13" />
          </button>
        </div>
      </template>
    </div>

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

.preview-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
  z-index: 1;
}

.marquee {
  fill: rgb(64 132 255 / 12%);
  stroke: #4084ff;
  stroke-width: 1;
  stroke-dasharray: 4 3;
}

.selbox {
  fill: none;
  stroke: #4084ff;
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
}

.img-xform {
  position: absolute;
  z-index: 2;
  box-sizing: border-box;
  border: 1.5px dashed #4084ff;
  transform-origin: center;
  pointer-events: none;
}

.img-xform .handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #fff;
  border: 2px solid #4084ff;
  border-radius: 50%;
  box-sizing: border-box;
  pointer-events: auto;
  cursor: grab;
}

.img-xform .handle.rot {
  left: 50%;
  top: -26px;
  transform: translateX(-50%);
}

.img-xform .rot-line {
  position: absolute;
  left: 50%;
  top: -14px;
  width: 1.5px;
  height: 14px;
  background: #4084ff;
  pointer-events: none;
}

.img-xform .handle.scale {
  right: -7px;
  bottom: -7px;
  cursor: nwse-resize;
}

.img-xform .xf-actions {
  position: absolute;
  left: 50%;
  bottom: -34px;
  transform: translateX(-50%);
  display: flex;
  gap: 6px;
  pointer-events: auto;
}

.img-xform .xf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 6px;
  cursor: pointer;
}

.img-xform .xf-btn:hover {
  color: var(--accent);
}

.img-xform .xf-btn.ok {
  background: #4084ff;
  border-color: #4084ff;
  color: #fff;
}

.img-xform .crop-shade {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.img-xform .crop-box {
  position: absolute;
  border: 1.5px solid #fff;
  box-shadow: 0 0 0 9999px rgb(0 0 0 / 45%);
}

.img-xform .handle.crop-h {
  transform: translate(-50%, -50%);
  cursor: crosshair;
}

.eraser-ring {
  position: absolute;
  z-index: 2;
  box-sizing: border-box;
  border: 1.5px solid rgb(0 0 0 / 55%);
  border-radius: 50%;
  background: rgb(255 255 255 / 25%);
  pointer-events: none;
  transform: translate(-50%, -50%);
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
