// Blob ↔ dataURL：语音消息经 control 通道以 base64 直传时用。

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function dataURLToBlob(dataUrl: string, fallbackMime = 'application/octet-stream'): Blob {
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(0, comma)
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? fallbackMime
  const raw = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * 生成图片文件的小尺寸缩略图 dataURL（聊天气泡内联预览）。
 * 非图片、超大文件或解码失败时返回 undefined —— 预览是锦上添花，不阻塞共享。
 */
export async function makeImageThumb(file: File, max = 320): Promise<string | undefined> {
  if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) return undefined
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const url = canvas.toDataURL('image/jpeg', 0.72)
    // 过大的缩略图不值得随元信息广播。
    return url.length <= 64 * 1024 ? url : undefined
  } catch {
    return undefined
  }
}
