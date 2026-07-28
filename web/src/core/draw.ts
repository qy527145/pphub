// 白板 / 屏幕批注共用的绘制工具：笔画渲染、坐标归一化、配色。
// 笔画坐标统一为 [0,1] 归一化，渲染时映射到目标画布像素。

import type { WbStroke } from './messages'

/** 线宽参考逻辑宽度：stroke.size 表示画布宽为 1280px 时的像素线宽。 */
export const LOGICAL_WIDTH = 1280

/** 画笔预设色板（画在白底画布上，需两种主题下都可辨识）。 */
export const PEN_COLORS = ['#e5484d', '#ff8a00', '#0f9d58', '#6c4bf4', '#00a693', '#22272e']

/** 画笔预设粗细（逻辑像素）。 */
export const PEN_SIZES = [3, 6, 12]

/** 橡皮固定宽度（逻辑像素）。 */
export const ERASER_SIZE = 36

/**
 * 全量重绘一组笔画。橡皮以 destination-out 抠除，因此必须按时间序整体
 * 重绘（不能只画增量之外还保留旧橡皮效果的正确性）。
 */
export function renderStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Iterable<WbStroke>,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h)
  for (const s of strokes) drawStroke(ctx, s, w, h)
}

/** 画一条笔画（相邻采样点间以中点二次贝塞尔平滑）。 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  s: WbStroke,
  w: number,
  h: number,
): void {
  const pts = s.points
  if (pts.length < 2) return
  ctx.save()
  ctx.globalCompositeOperation = s.mode === 'eraser' ? 'destination-out' : 'source-over'
  ctx.strokeStyle = s.color
  ctx.lineWidth = Math.max(1, (s.size * w) / LOGICAL_WIDTH)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(pts[0] * w, pts[1] * h)
  if (pts.length === 2) {
    ctx.lineTo(pts[0] * w, pts[1] * h)
  } else {
    for (let i = 2; i + 1 < pts.length; i += 2) {
      const px = pts[i - 2] * w
      const py = pts[i - 1] * h
      const cx = pts[i] * w
      const cy = pts[i + 1] * h
      ctx.quadraticCurveTo(px, py, (px + cx) / 2, (py + cy) / 2)
    }
    const n = pts.length
    ctx.lineTo(pts[n - 2] * w, pts[n - 1] * h)
  }
  ctx.stroke()
  ctx.restore()
}

/** 根据 peerId 派生稳定的成员标识色（远程光标用）。 */
export function peerColor(peerId: string): string {
  let hash = 0
  for (let i = 0; i < peerId.length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) | 0
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue} 65% 45%)`
}

/**
 * object-fit: contain 的内容区几何：视频 (vw×vh) 放进容器 (cw×ch) 后
 * 实际显示矩形（相对容器的偏移与尺寸），画布叠加与坐标归一化都用它。
 */
export interface ContentRect {
  left: number
  top: number
  width: number
  height: number
}

export function containRect(cw: number, ch: number, vw: number, vh: number): ContentRect {
  if (cw <= 0 || ch <= 0 || vw <= 0 || vh <= 0) return { left: 0, top: 0, width: cw, height: ch }
  const scale = Math.min(cw / vw, ch / vh)
  const width = vw * scale
  const height = vh * scale
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height }
}

/** 把容器内的指针事件坐标换算为内容区 [0,1] 归一化坐标（越界返回 null）。 */
export function normalizePoint(
  rect: ContentRect,
  offsetX: number,
  offsetY: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const x = (offsetX - rect.left) / rect.width
  const y = (offsetY - rect.top) / rect.height
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}
