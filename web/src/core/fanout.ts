// 路线乙：服务器扇出的媒体分发枢纽。
//
// 大房间里，屏幕/语音的网状上行是 O(N)——发送端要给每个观众各传一份，
// 家用上行几个观众就压满。FanoutHub 让发送端**只编码一次、只加密一次、
// 只上行一次**：把 WebCodecs 编出的包用发送端自己的媒体群密钥加密，交给
// 服务器扇出（见 Rust 侧 `Rooms::fanout`），服务器只复制密文、看不到明文，
// 端到端加密不破。
//
// 群密钥（32 字节）由发送端随机生成，经**每对加密的 control 通道**用 media-key
// 消息发给每位观众（绝不过服务器明文）。房间成员皆为授权观众，无需轮换。
// 屏幕与语音复用同一把发送端密钥，帧内 kind 字节区分（且在密文内被鉴权）。
//
// 线格式：
//   发送端 → 服务器：[0]=2, [1..]=inner
//   服务器 → 观众：  [0]=2, [1]=srcId 长度 n, [2..2+n]=来源 peerId, [2+n..]=inner
//   inner = [nonce:12][cipher]，cipher = seal(groupKey, nonce, [kind:1] ++ packet)

import { NONCE_LEN, NonceGen, fromBase64, open, randomBytes, seal, toBase64 } from './crypto'

/** 扇出帧的外层版本字节（区别于 1:1 中继的版本 1）。 */
const OUTER_VERSION = 2
/** 密文内首字节：区分屏幕 / 语音包（被 AEAD 鉴权，服务器改不了也看不见）。 */
const KIND_SCREEN = 0
const KIND_VOICE = 1
/** 媒体群密钥字节数（ChaCha20-Poly1305 对称密钥）。 */
const MEDIA_KEY_LEN = 32

export interface FanoutHubConfig {
  /** 把一帧扇出数据发给服务器（已封 `[2][inner]`）。mesh 接到 signaling.sendRelay。 */
  sendFrame: (frame: ArrayBuffer) => void
  /** 收到某发送端的屏幕包（已解密，即 screencodec 的包）。 */
  onScreen: (from: string, packet: ArrayBuffer) => void
  /** 收到某发送端的语音包（已解密，即 voicecodec 的包）。 */
  onVoice: (from: string, packet: ArrayBuffer) => void
}

/**
 * 媒体扇出枢纽：一端既是发送端（sendScreen/sendVoice），也是观众（handleFrame）。
 * 每个 Mesh 会话持有一个实例，进入 fanout 层级时启用。
 */
export class FanoutHub {
  private readonly cfg: FanoutHubConfig
  /** 本端媒体群密钥：屏幕/语音复用同一把（帧内 kind 区分）。 */
  private readonly localKey = randomBytes(MEDIA_KEY_LEN)
  /** 本端出站 nonce：单调递增，配合单一密钥保证 nonce 永不重复。 */
  private readonly nonces = new NonceGen()
  /** 各发送端的群密钥（观众侧解密用），peerId → key。 */
  private readonly remoteKeys = new Map<string, Uint8Array>()

  constructor(cfg: FanoutHubConfig) {
    this.cfg = cfg
  }

  /** 本端群密钥（base64），经 media-key 分发给各观众。 */
  get keyBase64(): string {
    return toBase64(this.localKey)
  }

  /** 登记某发送端的群密钥（收到其 media-key 时调用）。 */
  setRemoteKey(peerId: string, keyBase64: string): void {
    const key = fromBase64(keyBase64)
    if (key.length === MEDIA_KEY_LEN) this.remoteKeys.set(peerId, key)
  }

  /** 是否已持有某发送端的群密钥（决定其扇出帧能否解密）。 */
  hasRemoteKey(peerId: string): boolean {
    return this.remoteKeys.has(peerId)
  }

  removeRemoteKey(peerId: string): void {
    this.remoteKeys.delete(peerId)
  }

  /** 发一个屏幕包（screencodec 的包），加密后经服务器扇出。 */
  sendScreen(packet: ArrayBuffer): void {
    this.sendMedia(KIND_SCREEN, packet)
  }

  /** 发一个语音包（voicecodec 的包），加密后经服务器扇出。 */
  sendVoice(packet: ArrayBuffer): void {
    this.sendMedia(KIND_VOICE, packet)
  }

  private sendMedia(kind: number, packet: ArrayBuffer): void {
    const body = new Uint8Array(packet)
    const plain = new Uint8Array(1 + body.length)
    plain[0] = kind
    plain.set(body, 1)
    const nonce = this.nonces.next()
    const cipher = seal(this.localKey, nonce, plain)
    const frame = new Uint8Array(1 + NONCE_LEN + cipher.length)
    frame[0] = OUTER_VERSION
    frame.set(nonce, 1)
    frame.set(cipher, 1 + NONCE_LEN)
    this.cfg.sendFrame(frame.buffer)
  }

  /** 服务器扇出帧到达（`[2][srcLen][srcId][nonce][cipher]`），解密后分发。 */
  handleFrame(frame: ArrayBuffer): void {
    const buf = new Uint8Array(frame)
    if (buf.length < 2 || buf[0] !== OUTER_VERSION) return
    const idLen = buf[1]
    const headLen = 2 + idLen
    if (idLen === 0 || buf.length < headLen + NONCE_LEN) return
    const from = new TextDecoder().decode(buf.subarray(2, headLen))
    const key = this.remoteKeys.get(from)
    if (!key) return // 还没拿到该发送端的群密钥，无法解密（media-key 稍后即到）

    const nonce = buf.subarray(headLen, headLen + NONCE_LEN)
    const cipher = buf.subarray(headLen + NONCE_LEN)
    let plain: Uint8Array
    try {
      plain = open(key, nonce, cipher)
    } catch {
      return // AEAD 鉴权失败：丢弃
    }
    if (plain.length < 1) return

    // slice() 拷出一段独立底层缓冲，避免下游持有对整帧的视图。
    const packet = plain.subarray(1).slice().buffer
    if (plain[0] === KIND_SCREEN) this.cfg.onScreen(from, packet)
    else if (plain[0] === KIND_VOICE) this.cfg.onVoice(from, packet)
  }

  /** 清空登记的远端密钥（离开房间时调用）。 */
  reset(): void {
    this.remoteKeys.clear()
  }
}

/** 一帧数据是否为服务器扇出帧（外层版本 2）。mesh 的 relay 分流用。 */
export function isFanoutFrame(frame: ArrayBuffer): boolean {
  const buf = new Uint8Array(frame)
  return buf.length >= 1 && buf[0] === OUTER_VERSION
}
