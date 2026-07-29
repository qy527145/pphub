// 分块共享引擎（懒发送 + 多源下载）。
//
// 与「强制发送」（filetransfer.ts，推模型）互补，这里是拉模型：
//   1. 共享方登记 share-offer（懒发送时不上传任何字节，只登记元信息）；
//   2. 下载方向所有已连接节点发 have-req，收集各自持有的分块位图；
//   3. 按「最少可得分块优先」把请求分散到多个源，每源限流并发，
//      失败/超时自动换源重试；
//   4. 下载完成的分块本端也对外声明 have —— 拿到片段的节点即刻成为新源，
//      源越多单点负载越低（BitTorrent 式扇出）。
//
// 分块数据走独立的二进制 `swarm` 通道：前 4 字节小端 reqId，其后为负载。

import { CHUNK_SIZE } from './channels'
import type { SharedFileMeta } from './messages'

export { CHUNK_SIZE }

/** 单个源上同时在途的分块请求数：够跑满带宽，又不至于把某节点打满。 */
export const PER_PEER_INFLIGHT = 4

/** 单块请求超时（ms）：超时即换源重试。 */
export const CHUNK_TIMEOUT_MS = 15_000

/** 分块位图。base64 传输，按 index 位寻址。 */
export class Bitfield {
  readonly size: number
  private readonly bytes: Uint8Array
  private have = 0

  constructor(size: number) {
    this.size = size
    this.bytes = new Uint8Array(Math.ceil(size / 8))
  }

  static full(size: number): Bitfield {
    const bf = new Bitfield(size)
    for (let i = 0; i < size; i++) bf.set(i)
    return bf
  }

  static fromBase64(b64: string, size: number): Bitfield {
    const bf = new Bitfield(size)
    let raw: string
    try {
      raw = atob(b64)
    } catch {
      return bf
    }
    for (let i = 0; i < size; i++) {
      const byte = raw.charCodeAt(i >> 3)
      if (byte && byte & (1 << (i & 7))) bf.set(i)
    }
    return bf
  }

  has(i: number): boolean {
    return (this.bytes[i >> 3] & (1 << (i & 7))) !== 0
  }

  set(i: number): void {
    if (i < 0 || i >= this.size || this.has(i)) return
    this.bytes[i >> 3] |= 1 << (i & 7)
    this.have++
  }

  clear(i: number): void {
    if (i < 0 || i >= this.size || !this.has(i)) return
    this.bytes[i >> 3] &= ~(1 << (i & 7))
    this.have--
  }

  get count(): number {
    return this.have
  }

  get complete(): boolean {
    return this.have >= this.size
  }

  toBase64(): string {
    let s = ''
    for (const b of this.bytes) s += String.fromCharCode(b)
    return btoa(s)
  }
}

export function chunkCount(size: number, chunkSize = CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize))
}

/**
 * 一个文件的本地分块仓库。两种来源：
 *   - 本机 File（共享方）：按需 slice，零内存占用；
 *   - 内存分块（下载方）：边下边存，同时可对外供块（成为新的源）。
 */
export class FileStore {
  readonly meta: SharedFileMeta
  readonly bitfield: Bitfield
  private readonly file: File | null
  private readonly parts: (ArrayBuffer | undefined)[]

  constructor(meta: SharedFileMeta, file: File | null) {
    this.meta = meta
    this.file = file
    this.parts = new Array(meta.chunks)
    this.bitfield = file ? Bitfield.full(meta.chunks) : new Bitfield(meta.chunks)
  }

  get complete(): boolean {
    return this.bitfield.complete
  }

  /** 已持有的字节数（末块可能不足一整块）。 */
  get bytes(): number {
    if (this.file) return this.meta.size
    let n = 0
    for (let i = 0; i < this.meta.chunks; i++) {
      if (this.bitfield.has(i)) n += this.chunkLength(i)
    }
    return n
  }

  chunkLength(index: number): number {
    const { size, chunkSize } = this.meta
    const start = index * chunkSize
    return Math.max(0, Math.min(chunkSize, size - start))
  }

  async read(index: number): Promise<ArrayBuffer | null> {
    if (index < 0 || index >= this.meta.chunks) return null
    if (this.file) {
      const start = index * this.meta.chunkSize
      return this.file.slice(start, start + this.meta.chunkSize).arrayBuffer()
    }
    return this.parts[index] ?? null
  }

  /** 收下一个分块；返回 true 表示这是新块（需要对外声明 have）。 */
  write(index: number, buf: ArrayBuffer): boolean {
    if (index < 0 || index >= this.meta.chunks || this.bitfield.has(index)) return false
    this.parts[index] = buf
    this.bitfield.set(index)
    return true
  }

  /** 组装成 Blob（仅下载完成后调用）。 */
  toBlob(): Blob {
    const list: ArrayBuffer[] = []
    for (let i = 0; i < this.meta.chunks; i++) {
      const p = this.parts[i]
      if (p) list.push(p)
    }
    return new Blob(list, { type: this.meta.mime || 'application/octet-stream' })
  }
}

/** 一次分块请求的投递结果。 */
export interface ChunkRequester {
  /** 向某源请求一个分块；返回 false 表示该源通道不可用。 */
  request(peerId: string, reqId: number, fileId: string, index: number): boolean
}

interface Inflight {
  peerId: string
  index: number
  timer: ReturnType<typeof setTimeout>
}

/** 已放弃的源在被移除前允许的失败次数上限之外的兜底常量。 */
const MAX_EXTRA_FAILURES = 16

// reqId 在页面内全局递增：多个并发下载共用 swarm 通道，靠它区分帧归属。
let globalReqId = 1
function allocReqId(): number {
  return globalReqId++
}

export interface DownloadCallbacks {
  onProgress(bytes: number): void
  onDone(blob: Blob): void
  onError(reason: string): void
  /** 新分块到手：上层据此向全网声明 have，让本端成为新的源。 */
  onChunk(index: number): void
  /** 当前实际参与供块的源数量变化（UI 展示「N 源下载中」）。 */
  onSources(count: number): void
}

/**
 * 一个文件的多源下载任务。调度目标：
 *   - 每个源最多 PER_PEER_INFLIGHT 个在途请求，避免打满单点；
 *   - 优先取「持有者最少」的块（rarest-first），减少尾部长尾；
 *   - 超时或被 nak 的块放回队列换源重试。
 */
export class Download {
  readonly store: FileStore
  private readonly cb: DownloadCallbacks
  private readonly requester: ChunkRequester
  /** peerId → 该源持有的分块位图。 */
  private readonly sources = new Map<string, Bitfield>()
  /** 在途请求：reqId → 请求详情（reqId 唯一，同块换源重试不会互相覆盖）。 */
  private readonly inflight = new Map<number, Inflight>()
  /** 已排出请求的块，避免重复请求同一块。 */
  private readonly pendingIndex = new Set<number>()
  /** peerId → 在途请求数。 */
  private readonly load = new Map<string, number>()
  /** 累计失败次数（超过阈值放弃，避免无限重试）。 */
  private failures = 0
  private settled = false

  constructor(meta: SharedFileMeta, requester: ChunkRequester, cb: DownloadCallbacks) {
    this.store = new FileStore(meta, null)
    this.requester = requester
    this.cb = cb
    // 源发现超时：have-req 广播后迟迟无人应答，判定不可下载。
    setTimeout(() => {
      if (!this.settled && this.sources.size === 0) this.fail('未发现可用的源')
    }, CHUNK_TIMEOUT_MS)
  }

  get fileId(): string {
    return this.store.meta.fileId
  }

  get sourceCount(): number {
    return this.sources.size
  }

  /** 该 reqId 是否属于本下载的在途请求（mesh 据此路由 swarm 帧）。 */
  ownsReq(reqId: number): boolean {
    return this.inflight.has(reqId)
  }

  /** 登记/更新一个源的持有情况，并立刻尝试排新请求。 */
  addSource(peerId: string, bits: Bitfield): void {
    if (this.settled) return
    this.sources.set(peerId, bits)
    this.cb.onSources(this.sources.size)
    this.pump()
  }

  /** 源离线或撤销共享：撤掉它的在途请求，交给其它源重试。 */
  dropSource(peerId: string): void {
    if (!this.sources.delete(peerId)) return
    this.cb.onSources(this.sources.size)
    for (const [reqId, f] of [...this.inflight]) {
      if (f.peerId === peerId) this.release(reqId)
    }
    // 会话内续传：所有源都掉线时不作废下载，保留已到手的分块进入「停摆」，
    // 等任一源恢复（对端重连 / 传输层降级后通道重开）再自动续传。
    // UI 依据 onSources(0) 呈现等待态。
    if (this.sources.size === 0) return
    this.pump()
  }

  /** 收到一个分块（reqId 关联到具体请求，进而定位块号）。 */
  onData(peerId: string, reqId: number, buf: ArrayBuffer): void {
    if (this.settled) return
    const f = this.inflight.get(reqId)
    if (!f) return
    this.release(reqId)
    if (this.store.write(f.index, buf)) {
      this.failures = 0
      this.cb.onProgress(this.store.bytes)
      this.cb.onChunk(f.index)
    }
    // 供块方确实有这一块，补进它的位图（首次 have 可能还没到）。
    this.sources.get(peerId)?.set(f.index)
    if (this.store.complete) {
      this.finish()
      return
    }
    this.pump()
  }

  /** 某源拒绝提供该块：从它的位图里划掉，换源重试。 */
  onNak(peerId: string, reqId: number): void {
    if (this.settled) return
    const f = this.inflight.get(reqId)
    this.failures++
    if (f) {
      // 它自称有、实际给不出：划掉这一位，避免再被 pickSource 选中。
      this.sources.get(peerId)?.clear(f.index)
      this.release(reqId)
    }
    if (this.failures > this.store.meta.chunks * 2 + MAX_EXTRA_FAILURES) {
      this.fail('多次请求均失败，已停止下载')
      return
    }
    this.pump()
  }

  cancel(): void {
    if (this.settled) return
    this.settled = true
    this.clearInflight()
  }

  /** 把能排的请求都排出去（受每源并发上限约束）。 */
  private pump(): void {
    if (this.settled || this.sources.size === 0) return
    for (;;) {
      const index = this.pickChunk()
      if (index === null) break
      const peerId = this.pickSource(index)
      if (!peerId) break
      const reqId = allocReqId()
      if (!this.requester.request(peerId, reqId, this.fileId, index)) {
        // 通道不可用：该源作废，重新评估（dropSource 会再次 pump）。
        this.dropSource(peerId)
        return
      }
      const timer = setTimeout(() => {
        this.release(reqId)
        this.failures++
        this.pump()
      }, CHUNK_TIMEOUT_MS)
      this.inflight.set(reqId, { peerId, index, timer })
      this.pendingIndex.add(index)
      this.load.set(peerId, (this.load.get(peerId) ?? 0) + 1)
    }
  }

  /** 挑一个未持有、未在途、且至少有一个源能给的块（rarest-first）。 */
  private pickChunk(): number | null {
    let best: number | null = null
    let bestOwners = Infinity
    for (let i = 0; i < this.store.meta.chunks; i++) {
      if (this.store.bitfield.has(i) || this.pendingIndex.has(i)) continue
      let owners = 0
      for (const bits of this.sources.values()) {
        if (bits.has(i)) owners++
      }
      if (owners === 0) continue
      if (owners < bestOwners) {
        best = i
        bestOwners = owners
        if (owners === 1) break
      }
    }
    return best
  }

  /** 在持有该块的源中挑当前在途最少的那个。 */
  private pickSource(index: number): string | null {
    let best: string | null = null
    let bestLoad = PER_PEER_INFLIGHT
    for (const [peerId, bits] of this.sources) {
      if (!bits.has(index)) continue
      const load = this.load.get(peerId) ?? 0
      if (load < bestLoad) {
        best = peerId
        bestLoad = load
      }
    }
    return best
  }

  /** 结束一次在途请求（无论成功、超时还是被拒），释放该源的并发额度。 */
  private release(reqId: number): void {
    const f = this.inflight.get(reqId)
    if (!f) return
    clearTimeout(f.timer)
    this.inflight.delete(reqId)
    this.pendingIndex.delete(f.index)
    this.load.set(f.peerId, Math.max(0, (this.load.get(f.peerId) ?? 1) - 1))
  }

  private clearInflight(): void {
    for (const [reqId] of [...this.inflight]) this.release(reqId)
  }

  private finish(): void {
    if (this.settled) return
    this.settled = true
    this.clearInflight()
    this.cb.onDone(this.store.toBlob())
  }

  private fail(reason: string): void {
    if (this.settled) return
    this.settled = true
    this.clearInflight()
    this.cb.onError(reason)
  }
}

/** swarm 通道帧：4 字节小端 reqId + 负载。 */
export function packChunk(reqId: number, payload: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(4 + payload.byteLength)
  new DataView(out.buffer).setUint32(0, reqId, true)
  out.set(new Uint8Array(payload), 4)
  return out.buffer
}

export function unpackChunk(buf: ArrayBuffer): { reqId: number; payload: ArrayBuffer } | null {
  if (buf.byteLength < 4) return null
  const reqId = new DataView(buf).getUint32(0, true)
  return { reqId, payload: buf.slice(4) }
}
