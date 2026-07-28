// 白板 / 屏幕批注共用的绘制工具：元素渲染、坐标归一化、配色。
// 所有坐标统一为 [0,1] 归一化，渲染时映射到目标画布像素。

import type { WbItem, WbStroke, WbLine, WbPolyline, WbText, WbImage } from './messages'

/** 线宽参考逻辑宽度：stroke.size 表示画布宽为 1280px 时的像素线宽。 */
export const LOGICAL_WIDTH = 1280

/** 画笔预设色板（画在白底画布上，需两种主题下都可辨识）。 */
export const PEN_COLORS = ['#e5484d', '#ff8a00', '#0f9d58', '#6c4bf4', '#00a693', '#22272e']

/** 画笔预设粗细（逻辑像素）。 */
export const PEN_SIZES = [3, 6, 12]

/** 橡皮可选宽度（逻辑像素）。 */
export const ERASER_SIZES = [20, 36, 60]

/** 文本字号预设（逻辑像素）。 */
export const TEXT_SIZES = [16, 24, 36]

/**
 * 全量重绘所有元素。橡皮以 destination-out 抠除，因此必须按时间序整体
 * 重绘（不能只画增量之外还保留旧橡皮效果的正确性）。
 */
export function renderStrokes(
  ctx: CanvasRenderingContext2D,
  items: Iterable<WbItem>,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h)
  for (const item of items) {
    if (item.mode === 'pen' || item.mode === 'eraser') {
      drawStroke(ctx, item as WbStroke, w, h)
    } else if (item.mode === 'line' || item.mode === 'arrow') {
      drawLine(ctx, item as WbLine, w, h)
    } else if (item.mode === 'rect' || item.mode === 'ellipse') {
      drawShape(ctx, item as WbLine, w, h)
    } else if (item.mode === 'polyline') {
      drawPolyline(ctx, item as WbPolyline, w, h)
    } else if (item.mode === 'text') {
      drawText(ctx, item as WbText, w, h)
    } else if (item.mode === 'image') {
      drawImage(ctx, item as WbImage, w, h)
    }
  }
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

/** 画一条直线或箭头。 */
export function drawLine(
  ctx: CanvasRenderingContext2D,
  line: WbLine,
  w: number,
  h: number,
): void {
  ctx.save()
  ctx.strokeStyle = line.color
  ctx.lineWidth = Math.max(1, (line.size * w) / LOGICAL_WIDTH)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const x1 = line.x1 * w
  const y1 = line.y1 * h
  const x2 = line.x2 * w
  const y2 = line.y2 * h

  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()

  // 绘制箭头
  if (line.mode === 'arrow') {
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const arrowLen = Math.min(30, Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) * 0.3)
    const arrowAngle = Math.PI / 6

    ctx.fillStyle = line.color
    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(
      x2 - arrowLen * Math.cos(angle - arrowAngle),
      y2 - arrowLen * Math.sin(angle - arrowAngle)
    )
    ctx.lineTo(
      x2 - arrowLen * Math.cos(angle + arrowAngle),
      y2 - arrowLen * Math.sin(angle + arrowAngle)
    )
    ctx.closePath()
    ctx.fill()
  }

  ctx.restore()
}

/** 画矩形/椭圆框线（两角点定界，不填充）。 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: WbLine,
  w: number,
  h: number,
): void {
  const r = normalizeRect(shape)
  const x = r.x1 * w
  const y = r.y1 * h
  const rw = (r.x2 - r.x1) * w
  const rh = (r.y2 - r.y1) * h
  ctx.save()
  ctx.strokeStyle = shape.color
  ctx.lineWidth = Math.max(1, (shape.size * w) / LOGICAL_WIDTH)
  ctx.lineJoin = 'round'
  ctx.beginPath()
  if (shape.mode === 'rect') {
    ctx.rect(x, y, rw, rh)
  } else {
    ctx.ellipse(x + rw / 2, y + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2)
  }
  ctx.stroke()
  ctx.restore()
}

/** 画文本元素。 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: WbText,
  w: number,
  h: number,
): void {
  ctx.save()
  ctx.fillStyle = text.color
  ctx.font = `${(text.fontSize * w) / LOGICAL_WIDTH}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillText(text.text, text.x * w, text.y * h)
  ctx.restore()
}

/** 画折线，arrow=true 时在末段加箭头。 */
export function drawPolyline(
  ctx: CanvasRenderingContext2D,
  pl: WbPolyline,
  w: number,
  h: number,
): void {
  const pts = pl.points
  if (pts.length < 4) return
  ctx.save()
  ctx.strokeStyle = pl.color
  ctx.lineWidth = Math.max(1, (pl.size * w) / LOGICAL_WIDTH)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(pts[0] * w, pts[1] * h)
  for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i] * w, pts[i + 1] * h)
  ctx.stroke()

  if (pl.arrow) {
    const n = pts.length
    drawArrowHead(
      ctx,
      pts[n - 4] * w,
      pts[n - 3] * h,
      pts[n - 2] * w,
      pts[n - 1] * h,
      pl.color,
    )
  }
  ctx.restore()
}

/** 在 (x1,y1)->(x2,y2) 的末端画实心箭头。 */
export function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const len = Math.min(30, Math.hypot(x2 - x1, y2 - y1) * 0.3)
  const spread = Math.PI / 6
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - len * Math.cos(angle - spread), y2 - len * Math.sin(angle - spread))
  ctx.lineTo(x2 - len * Math.cos(angle + spread), y2 - len * Math.sin(angle + spread))
  ctx.closePath()
  ctx.fill()
}

/** 画图片元素（使用缓存机制避免重复加载）。 */
const imageCache = new Map<string, HTMLImageElement>()

/** 图片解码完成后需要触发的重绘回调（由渲染层注册）。 */
let onImageReady: (() => void) | null = null

export function setImageReadyHandler(fn: (() => void) | null): void {
  onImageReady = fn
}

export function drawImage(
  ctx: CanvasRenderingContext2D,
  img: WbImage,
  w: number,
  h: number,
): void {
  let image = imageCache.get(img.dataUrl)
  if (!image) {
    image = new Image()
    imageCache.set(img.dataUrl, image)
    // 解码完成后请求整层重绘，不能往当前这帧的 ctx 上补画（可能已被清屏）
    image.onload = () => onImageReady?.()
    image.src = img.dataUrl
  }
  if (image.complete && image.naturalWidth > 0) {
    ctx.drawImage(image, img.x * w, img.y * h, img.width * w, img.height * h)
  }
}

/** 归一化坐标下的矩形区域。 */
export interface NormRect {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** 把两个角点整理成 x1<=x2、y1<=y2 的矩形。 */
export function normalizeRect(r: NormRect): NormRect {
  return {
    x1: Math.min(r.x1, r.x2),
    y1: Math.min(r.y1, r.y2),
    x2: Math.max(r.x1, r.x2),
    y2: Math.max(r.y1, r.y2),
  }
}

/** 元素的归一化包围盒（文本按字号估算，够用于框选/擦除判定）。 */
export function itemBounds(item: WbItem, aspect = 1): NormRect {
  if (item.mode === 'pen' || item.mode === 'eraser' || item.mode === 'polyline') {
    const pts = item.points
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    for (let i = 0; i + 1 < pts.length; i += 2) {
      x1 = Math.min(x1, pts[i])
      x2 = Math.max(x2, pts[i])
      y1 = Math.min(y1, pts[i + 1])
      y2 = Math.max(y2, pts[i + 1])
    }
    return { x1, y1, x2, y2 }
  }
  if (
    item.mode === 'line' ||
    item.mode === 'arrow' ||
    item.mode === 'rect' ||
    item.mode === 'ellipse'
  ) {
    return normalizeRect(item)
  }
  if (item.mode === 'image') {
    return { x1: item.x, y1: item.y, x2: item.x + item.width, y2: item.y + item.height }
  }
  if (item.mode === 'text') {
    // 宽度按平均字宽 0.6em 估算
    const fh = item.fontSize / LOGICAL_WIDTH
    return {
      x1: item.x,
      y1: item.y,
      x2: item.x + item.text.length * fh * 0.6,
      y2: item.y + (fh * aspect || fh),
    }
  }
  return { x1: 0, y1: 0, x2: 0, y2: 0 }
}

/** 元素包围盒是否与矩形相交（框选判定）。 */
export function itemIntersectsRect(item: WbItem, rect: NormRect): boolean {
  const b = itemBounds(item)
  const r = normalizeRect(rect)
  return !(b.x2 < r.x1 || b.x1 > r.x2 || b.y2 < r.y1 || b.y1 > r.y2)
}

/** 点到线段的距离（归一化坐标，按宽高比折算成同一尺度）。 */
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  aspect: number,
): number {
  const sy = aspect
  const pyS = py * sy
  const ayS = ay * sy
  const byS = by * sy
  const dx = bx - ax
  const dy = byS - ayS
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, pyS - ayS)
  let t = ((px - ax) * dx + (pyS - ayS) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), pyS - (ayS + t * dy))
}

/**
 * 橡皮命中判定：以 (px,py) 为圆心、radius 为半径的圆是否碰到该元素。
 * radius/aspect 都是归一化尺度（radius 相对画布宽）。
 */
export function itemHitByCircle(
  item: WbItem,
  px: number,
  py: number,
  radius: number,
  aspect: number,
): boolean {
  if (item.mode === 'pen' || item.mode === 'eraser' || item.mode === 'polyline') {
    const pts = item.points
    if (pts.length === 2) {
      return distToSegment(px, py, pts[0], pts[1], pts[0], pts[1], aspect) <= radius
    }
    for (let i = 0; i + 3 < pts.length; i += 2) {
      if (distToSegment(px, py, pts[i], pts[i + 1], pts[i + 2], pts[i + 3], aspect) <= radius) {
        return true
      }
    }
    return false
  }
  if (item.mode === 'line' || item.mode === 'arrow') {
    return distToSegment(px, py, item.x1, item.y1, item.x2, item.y2, aspect) <= radius
  }
  if (item.mode === 'rect') {
    // 只命中框线：逐条边算距离，避免擦到框内的其他元素时误删矩形
    const r = normalizeRect(item)
    return (
      distToSegment(px, py, r.x1, r.y1, r.x2, r.y1, aspect) <= radius ||
      distToSegment(px, py, r.x2, r.y1, r.x2, r.y2, aspect) <= radius ||
      distToSegment(px, py, r.x2, r.y2, r.x1, r.y2, aspect) <= radius ||
      distToSegment(px, py, r.x1, r.y2, r.x1, r.y1, aspect) <= radius
    )
  }
  if (item.mode === 'ellipse') {
    // 只命中轮廓：在 aspect 折算后的尺度里沿圆心射线近似到轮廓的距离
    const r = normalizeRect(item)
    const cx = (r.x1 + r.x2) / 2
    const cy = ((r.y1 + r.y2) / 2) * aspect
    const rx = (r.x2 - r.x1) / 2
    const ry = ((r.y2 - r.y1) / 2) * aspect
    if (rx <= 0 || ry <= 0) return Math.hypot(px - cx, py * aspect - cy) <= radius
    const dx = px - cx
    const dy = py * aspect - cy
    const t = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
    if (t === 0) return Math.min(rx, ry) <= radius
    const len = Math.hypot(dx, dy)
    return Math.abs(len - len / t) <= radius
  }
  // 文本 / 图片：按包围盒膨胀 radius 判定
  const b = itemBounds(item, aspect)
  return (
    px >= b.x1 - radius &&
    px <= b.x2 + radius &&
    py >= b.y1 - radius / aspect &&
    py <= b.y2 + radius / aspect
  )
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
