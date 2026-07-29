// WS 中继传输（fallback）：当 WebRTC 各条路径（打洞 / 内置 TURN）都建不起来时，
// 让业务数据经信令 WebSocket 中转，从而只依赖服务器已经暴露的 HTTP/WS 端口。
//
// 与 WebRTC 路径的关键差异：中继节点是 pphub 服务器本身，DTLS 不再覆盖这段
// 链路，因此本模块自带端到端加密——X25519 协商共享密钥 + ChaCha20-Poly1305
// 逐帧加密（纯 JS，见 crypto.ts），服务器只看得到密文与路由用的 peerId。
// SAS 由双方公钥派生，与 WebRTC 路径一样可带外核对（见 security.ts）。
//
// 用纯 JS 而非 WebCrypto 是刻意的：`crypto.subtle` 在明文 http 下不存在，
// 而那恰是最需要中继的部署方式（局域网 IP 直接访问）。纯 JS 实现只依赖
// `crypto.getRandomValues`，于是 http 下的中继同样是密文而非明文转发。
// 边界见 crypto.ts 顶部注释：防窥探与被动监听，防不了能改 http 流量的主动攻击者。
//
// 外层线格式（与 src/ws.rs 的 relay_binary 一一对应）：
//   [0]        版本 = 1
//   [1]        peerId 字节长度 n
//   [2..2+n]   发送时 = 目标 peerId；收到时 = 服务器改写后的来源 peerId
//   [2+n..]    12 字节 nonce + ChaCha20-Poly1305 密文（含 16 字节标签）
//
// 密文明文再分一层轻头部，用一条中继复用多个逻辑通道：
//   [0]        kind：0=control(JSON) 1=swarm 2=file 数据 3=file 关闭 4=屏幕编码帧
//   kind=2/3   [1] = id 字节长度，[2..] = id，其后为负载
//
// 屏幕共享（kind=4）走 WebCodecs 自编码的帧，见 screencodec.ts；WebRTC 的**媒体轨**
// 仍然无法经此中继（SRTP 由浏览器内部收发，JS 拿不到编码帧），两者是不同的东西。

import type { ChannelLike } from './channels'
import {
  type KeyPair,
  NONCE_LEN,
  NonceGen,
  type SessionKeys,
  deriveSessionKeys,
  fromBase64,
  generateKeyPair,
  open,
  seal,
  sha256Hex,
  toBase64,
} from './crypto'
import { type Sas, computeSas } from './security'

const KIND_CONTROL = 0
const KIND_SWARM = 1
const KIND_FILE_DATA = 2
const KIND_FILE_CLOSE = 3
const KIND_SCREEN = 4

/** 单帧明文上限；服务器侧 MAX_RELAY_FRAME 为 256KiB，此处留出头部与 GCM 余量。 */
const MAX_PLAIN = 192 * 1024

/** 密钥就绪前的出站积压上限，防止对端始终不应答时内存无限增长。 */
const MAX_PENDING = 512

export interface RelayTransportConfig {
  /** 对端 peerId。 */
  remoteId: string
  /** 把一帧中继数据（含外层帧头）交给信令层发出。 */
  sendFrame: (frame: ArrayBuffer) => void
  /** 经普通 JSON 信令把本端公钥发给对端（量极小，无需走二进制通道）。 */
  sendKey: (key: string) => void
  /** 当前底层 WebSocket 的积压字节数，用作文件传输的背压信号。 */
  bufferedAmount: () => number
}

/**
 * 一条中继连接：负责密钥协商、逐帧加解密与逻辑通道复用。
 * 上层（Peer）把它当作 control + swarm 两条数据通道，外加按需开的 file 通道。
 */
export class RelayTransport {
  readonly remoteId: string
  private readonly cfg: RelayTransportConfig
  private keys: SessionKeys | null = null
  private readonly localKeys: KeyPair
  private remotePub: Uint8Array | null = null
  private readonly nonces = new NonceGen()
  private pending: Array<{ kind: number; id?: string; payload: ArrayBuffer }> = []
  private readonly channels = new Map<string, RelayChannel>()
  private closed = false

  /** 事件回调，由 Peer 注入。 */
  onControl: ((msg: unknown) => void) | null = null
  onChunk: ((data: ArrayBuffer) => void) | null = null
  onScreen: ((packet: ArrayBuffer) => void) | null = null
  onFileChannel: ((ev: { id: string; channel: ChannelLike }) => void) | null = null
  onReady: (() => void) | null = null
  onSas: ((sas: Sas) => void) | null = null

  constructor(cfg: RelayTransportConfig) {
    this.cfg = cfg
    this.remoteId = cfg.remoteId
    // 纯 JS 实现，任何上下文都能生成密钥，不存在「加密不可用」的分支。
    this.localKeys = generateKeyPair()
    this.cfg.sendKey(toBase64(this.localKeys.publicKey))
  }

  /** 密钥已协商完成，可收发业务数据。 */
  get ready(): boolean {
    return this.keys !== null && !this.closed
  }

  get bufferedAmount(): number {
    return this.cfg.bufferedAmount()
  }

  // —— 密钥协商 ——

  /** 收到对端公钥（由 Peer 从信令中转入）。重复收到以首次为准。 */
  acceptRemoteKey(key: string): void {
    if (this.remotePub || this.closed) return
    let pub: Uint8Array
    try {
      pub = fromBase64(key)
    } catch {
      console.error('[relay] 对端公钥格式非法')
      return
    }
    if (pub.length !== 32) {
      console.error('[relay] 对端公钥长度异常', pub.length)
      return
    }
    this.remotePub = pub
    this.derive()
  }

  private derive(): void {
    if (this.keys || !this.remotePub || this.closed) return
    try {
      this.keys = deriveSessionKeys(
        this.localKeys.secret,
        this.localKeys.publicKey,
        this.remotePub,
      )
    } catch (err) {
      console.error('[relay] 派生共享密钥失败', err)
      return
    }

    // SAS 走与 WebRTC 路径同一套派生（computeSas 内部排序，两端结果一致）。
    this.emitSas()

    const queued = this.pending
    this.pending = []
    for (const f of queued) this.encryptAndSend(f.kind, f.payload, f.id)
    this.onReady?.()
  }

  private emitSas(): void {
    if (!this.onSas || !this.remotePub) return
    try {
      this.onSas(
        computeSas(sha256Hex(this.localKeys.publicKey), sha256Hex(this.remotePub)),
      )
    } catch (err) {
      console.error('[relay] computeSas', err)
    }
  }

  // —— 出站 ——

  sendControl(msg: unknown): boolean {
    const payload = new TextEncoder().encode(JSON.stringify(msg))
    return this.queue(KIND_CONTROL, detach(payload))
  }

  sendChunk(frame: ArrayBuffer): boolean {
    return this.queue(KIND_SWARM, frame)
  }

  /**
   * 发一个屏幕编码包。与其它通道不同：密钥未就绪时直接丢弃而非排队——
   * 实时画面积压下来只会变成一堆过期帧，等就绪后的关键帧即可恢复。
   */
  sendScreen(packet: ArrayBuffer): boolean {
    if (!this.keys || this.closed) return false
    return this.queue(KIND_SCREEN, packet)
  }

  /**
   * 为一次文件传输开一条逻辑通道。返回值实现了 filetransfer.ts 依赖的
   * RTCDataChannel 子集（readyState / send / close / bufferedAmount / on*）。
   */
  createFileChannel(id: string): ChannelLike {
    const ch = new RelayChannel(id, this)
    this.channels.set(id, ch)
    return ch
  }

  /** RelayChannel 回调：发一帧文件数据。 */
  sendFileData(id: string, data: ArrayBuffer): boolean {
    return this.queue(KIND_FILE_DATA, data, id)
  }

  /** RelayChannel 回调：通知对端本方向已结束。 */
  sendFileClose(id: string): void {
    this.channels.delete(id)
    this.queue(KIND_FILE_CLOSE, new ArrayBuffer(0), id)
  }

  private queue(kind: number, payload: ArrayBuffer, id?: string): boolean {
    if (this.closed) return false
    if (payload.byteLength > MAX_PLAIN) {
      console.error('[relay] 帧超过上限，已丢弃', payload.byteLength)
      return false
    }
    if (!this.keys) {
      if (this.pending.length >= MAX_PENDING) return false
      this.pending.push({ kind, id, payload })
      return true
    }
    this.encryptAndSend(kind, payload, id)
    return true
  }

  private encryptAndSend(kind: number, payload: ArrayBuffer, id?: string): void {
    const keys = this.keys
    if (!keys || this.closed) return

    const withId = kind === KIND_FILE_DATA || kind === KIND_FILE_CLOSE
    const idBytes = withId ? new TextEncoder().encode(id ?? '') : EMPTY
    const head = withId ? 2 + idBytes.length : 1
    const plain = new Uint8Array(head + payload.byteLength)
    plain[0] = kind
    if (withId) {
      plain[1] = idBytes.length
      plain.set(idBytes, 2)
    }
    plain.set(new Uint8Array(payload), head)

    const nonce = this.nonces.next()
    let cipher: Uint8Array
    try {
      cipher = seal(keys.send, nonce, plain)
    } catch (err) {
      console.error('[relay] 加密失败', err)
      return
    }

    const to = new TextEncoder().encode(this.remoteId)
    const frame = new Uint8Array(2 + to.length + NONCE_LEN + cipher.length)
    frame[0] = 1
    frame[1] = to.length
    frame.set(to, 2)
    frame.set(nonce, 2 + to.length)
    frame.set(cipher, 2 + to.length + NONCE_LEN)
    this.cfg.sendFrame(frame.buffer)
  }

  // —— 入站 ——

  /** 处理一帧服务器转来的中继数据（外层帧头的 peerId 已被改写为来源）。 */
  handleFrame(frame: ArrayBuffer): void {
    const keys = this.keys
    if (!keys || this.closed) return
    const buf = new Uint8Array(frame)
    if (buf.length < 2 || buf[0] !== 1) return
    const bodyAt = 2 + buf[1]
    if (buf.length < bodyAt + NONCE_LEN) return

    let plain: Uint8Array
    try {
      plain = open(
        keys.recv,
        buf.subarray(bodyAt, bodyAt + NONCE_LEN),
        buf.subarray(bodyAt + NONCE_LEN),
      )
    } catch {
      // AEAD 认证失败：帧被篡改或密钥不匹配，静默丢弃。
      return
    }
    if (this.closed) return

    switch (plain[0]) {
      case KIND_CONTROL:
        try {
          this.onControl?.(JSON.parse(new TextDecoder().decode(plain.subarray(1))))
        } catch {
          /* 丢弃非法帧 */
        }
        break
      case KIND_SWARM:
        this.onChunk?.(detach(plain.subarray(1)))
        break
      case KIND_SCREEN:
        this.onScreen?.(detach(plain.subarray(1)))
        break
      case KIND_FILE_DATA: {
        const at = 2 + plain[1]
        const id = new TextDecoder().decode(plain.subarray(2, at))
        this.channelFor(id).deliver(detach(plain.subarray(at)))
        break
      }
      case KIND_FILE_CLOSE: {
        const id = new TextDecoder().decode(plain.subarray(2, 2 + plain[1]))
        this.channels.get(id)?.remoteClosed()
        this.channels.delete(id)
        break
      }
    }
  }

  /** 取（或按需新建并上报）某次文件传输的接收侧通道。 */
  private channelFor(id: string): RelayChannel {
    const existing = this.channels.get(id)
    if (existing) return existing
    const ch = new RelayChannel(id, this)
    this.channels.set(id, ch)
    // 先上报再投递首帧：上层要在这次回调里挂 onmessage。
    // 即便上层暂存通道等 file-offer，RelayChannel 也会缓存数据直到挂上处理器。
    this.onFileChannel?.({ id, channel: ch })
    return ch
  }

  close(): void {
    this.closed = true
    this.pending = []
    this.keys = null
    for (const ch of this.channels.values()) ch.remoteClosed()
    this.channels.clear()
  }
}

/**
 * 一次文件传输在中继上的逻辑通道，实现 filetransfer.ts 依赖的
 * RTCDataChannel 子集。继承 EventTarget 以便直接支持 addEventListener。
 */
class RelayChannel extends EventTarget implements ChannelLike {
  binaryType: BinaryType = 'arraybuffer'
  bufferedAmountLowThreshold = 0
  readyState: RTCDataChannelState = 'open'

  private readonly id: string
  private readonly transport: RelayTransport
  /** onmessage 挂上之前到达的数据（通道可能先于 file-offer 出现）。 */
  private backlog: ArrayBuffer[] = []
  private handler: ((ev: MessageEvent) => void) | null = null

  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(id: string, transport: RelayTransport) {
    super()
    this.id = id
    this.transport = transport
  }

  get onmessage(): ((ev: MessageEvent) => void) | null {
    return this.handler
  }

  set onmessage(fn: ((ev: MessageEvent) => void) | null) {
    this.handler = fn
    if (!fn) return
    const queued = this.backlog
    this.backlog = []
    for (const data of queued) fn(new MessageEvent('message', { data }))
  }

  /** 背压信号：中继数据最终压在信令 WebSocket 的发送缓冲上。 */
  get bufferedAmount(): number {
    return this.transport.bufferedAmount
  }

  send(data: ArrayBuffer): void {
    if (this.readyState !== 'open') return
    this.transport.sendFileData(this.id, data)
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.transport.sendFileClose(this.id)
    this.onclose?.()
  }

  /** 收到对端数据。 */
  deliver(data: ArrayBuffer): void {
    if (this.readyState === 'closed') return
    if (this.handler) this.handler(new MessageEvent('message', { data }))
    else this.backlog.push(data)
  }

  /** 对端关闭了通道（或整条中继断开）。 */
  remoteClosed(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.backlog = []
    this.onclose?.()
  }
}

const EMPTY = new Uint8Array(0)

/** 取视图对应的独立 ArrayBuffer，避免把整块底层缓冲连带传出去。 */
function detach(v: Uint8Array): ArrayBuffer {
  return v.byteOffset === 0 && v.byteLength === v.buffer.byteLength
    ? (v.buffer as ArrayBuffer)
    : (v.slice().buffer as ArrayBuffer)
}
