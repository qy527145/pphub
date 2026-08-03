// 中继链路的端到端加密原语。
//
// 为什么不用 WebCrypto：`crypto.subtle` 只在安全上下文（https / localhost）存在，
// 而 pphub 的典型部署——局域网内以明文 http + IP 访问——恰好不是安全上下文。
// 那里唯一还能用的随机源是 `crypto.getRandomValues`（已实测可用），于是把
// 密钥协商与逐帧加密都放到纯 JS 实现（@noble/*，经过审计），中继在 http 下
// 也保持真正的端到端加密，而不是退化成明文转发。
//
// 两条路径共用同一套实现（不做「有 subtle 就用原生」的分支）：实测
// ChaCha20-Poly1305 在 V8 上约 186 MB/s，远快于其下的 WebSocket，没有性能
// 理由留两条代码路径——而单一路径意味着 https 下跑的每个测试都在覆盖 http。
//
// 必须诚实说明的边界：明文 http 下**页面本身**是未经认证送达的，能改动流量的
// 主动攻击者可以替换 JS 来窃取密钥。因此这里的加密防的是「服务器运营者窥探」
// 与「链路上的被动监听」，防不了主动篡改者。这也正是浏览器要锁 `crypto.subtle`
// 的原因。UI 必须把这个区别讲清楚（见 NetworkView 的横幅）。

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

/** AEAD 的 nonce 长度（ChaCha20-Poly1305 固定 12 字节）。 */
export const NONCE_LEN = 12

/** AEAD 认证标签长度，用于计算密文相对明文的膨胀。 */
export const TAG_LEN = 16

export interface KeyPair {
  secret: Uint8Array
  /** 对端需要的公钥，经信令以 base64 传输。 */
  publicKey: Uint8Array
}

/**
 * 一条中继连接协商出的密钥材料。收发方向各用一把密钥，这样两端的
 * nonce 计数器互不干扰——同一把密钥下重用 nonce 会让 AEAD 完全失效，
 * 分方向 + 递增计数从结构上排除了这种可能（比随机 nonce 更稳）。
 */
export interface SessionKeys {
  send: Uint8Array
  recv: Uint8Array
}

export function generateKeyPair(): KeyPair {
  const secret = x25519.utils.randomSecretKey()
  return { secret, publicKey: x25519.getPublicKey(secret) }
}

/**
 * n 个密码学随机字节。用 `crypto.getRandomValues`——它在明文 http 下也可用
 * （不同于被锁在安全上下文里的 `crypto.subtle`），因此局域网明文部署也能
 * 生成媒体群密钥等对称密钥材料。
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

/**
 * X25519 协商 + HKDF-SHA256 派生双向密钥。
 *
 * 方向靠两个公钥的字典序确定：较小者记为 A。两端算出的 (send, recv) 恰好
 * 互补，无需额外协商谁是主叫。
 */
export function deriveSessionKeys(mySecret: Uint8Array, myPub: Uint8Array, theirPub: Uint8Array): SessionKeys {
  const shared = x25519.getSharedSecret(mySecret, theirPub)
  const iAmA = compareBytes(myPub, theirPub) < 0
  // salt 绑定两个公钥，使派生结果与这次握手一一对应。
  const salt = iAmA ? concat(myPub, theirPub) : concat(theirPub, myPub)
  const a2b = hkdf(sha256, shared, salt, utf8('pphub-relay-v1|a2b'), 32)
  const b2a = hkdf(sha256, shared, salt, utf8('pphub-relay-v1|b2a'), 32)
  return iAmA ? { send: a2b, recv: b2a } : { send: b2a, recv: a2b }
}

/** 加密一段明文，返回 nonce 与密文（密文含 16 字节认证标签）。 */
export function seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce).encrypt(plain)
}

/** 解密；认证失败会抛异常（调用方据此丢弃该帧）。 */
export function open(key: Uint8Array, nonce: Uint8Array, cipher: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce).decrypt(cipher)
}

/**
 * 单调递增的 nonce 生成器。计数器 96 位远大于任何会话的帧数，
 * 配合「每方向一把密钥」即可保证同一密钥下 nonce 永不重复。
 */
export class NonceGen {
  private readonly buf = new Uint8Array(NONCE_LEN)

  next(): Uint8Array {
    // 小端 +1：从低位起逐字节进位。
    for (let i = 0; i < NONCE_LEN; i++) {
      if (++this.buf[i] !== 0) break
    }
    return this.buf.slice()
  }
}

/** SHA-256 十六进制摘要（同步，不依赖 crypto.subtle）。 */
export function sha256Hex(data: Uint8Array): string {
  return toHex(sha256(data))
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(s)
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
