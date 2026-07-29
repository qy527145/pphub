// 文件夹打包：无压缩（store）zip。
//
// 为什么是 zip 而不是逐文件传目录结构：接收端浏览器没有可靠的「按路径落盘」
// 能力（FSA 仅 Chromium、<a download> 不支持子目录），打成单个 zip 后现有的
// 单文件传输/多源下载链路零改动，目录结构解压即得。
//
// 内存策略：产出的 Blob 由 [头部字节 + File 引用 + 目录字节] 拼成——File 部分
// 是惰性引用，不会整体读进内存；只有 CRC32 需要把每个文件顺序读一遍。

export interface ZipEntry {
  /** zip 内相对路径（'/' 分隔，不以 '/' 开头）。 */
  path: string
  file: File
}

const MAX32 = 0xffffffff

/** CRC32 查表（IEEE 802.3 多项式，zip 标准）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

async function crc32OfFile(file: File): Promise<number> {
  let crc = 0xffffffff
  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (let i = 0; i < value.length; i++) {
      crc = CRC_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS 时间戳（zip 头用），精度 2 秒，早于 1980 的钳到下限。 */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms)
  if (d.getFullYear() < 1980) return { time: 0, date: 0x21 }
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * 把一组文件打包成 store 模式的 zip Blob。
 * 不做 zip64：单文件、总体积超 4GB 或超 65535 个文件时抛错（诚实拒绝，
 * 而不是产出损坏的包）。
 */
export async function makeZip(entries: ZipEntry[], onProgress?: (done: number) => void): Promise<Blob> {
  if (entries.length > 0xffff) throw new Error(`文件夹内文件过多（${entries.length} 个，上限 65535）`)

  const encoder = new TextEncoder()
  const parts: (Uint8Array | File)[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (let i = 0; i < entries.length; i++) {
    const { path, file } = entries[i]
    if (file.size > MAX32) throw new Error(`「${path}」超过 4GB，zip 打包暂不支持`)
    const nameBytes = encoder.encode(path)
    const crc = await crc32OfFile(file)
    const { time, date } = dosDateTime(file.lastModified)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // 需要的解压版本 2.0
    lv.setUint16(6, 0x0800, true) // bit11：文件名为 UTF-8
    lv.setUint16(8, 0, true) // store，不压缩
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, file.size, true)
    lv.setUint32(22, file.size, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)

    const cen = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, file.size, true)
    cv.setUint32(24, file.size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    cen.set(nameBytes, 46)
    central.push(cen)

    parts.push(local, file)
    offset += local.length + file.size
    if (offset > MAX32) throw new Error('文件夹总体积超过 4GB，zip 打包暂不支持')
    onProgress?.(i + 1)
  }

  const centralStart = offset
  let centralSize = 0
  for (const c of central) {
    parts.push(c)
    centralSize += c.length
  }

  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralStart, true)
  parts.push(end)

  return new Blob(parts as BlobPart[], { type: 'application/zip' })
}

/** zip Blob → File（沿用现有 File 传输/共享链路）。 */
export async function zipFolder(folderName: string, entries: ZipEntry[]): Promise<File> {
  const blob = await makeZip(entries)
  return new File([blob], `${folderName}.zip`, { type: 'application/zip' })
}
