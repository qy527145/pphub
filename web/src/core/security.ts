// 短认证串（SAS）指纹校验。
//
// WebRTC 的 DTLS 握手已对媒体/数据做端到端加密，但信令服务器理论上能替换
// SDP 中的指纹发起中间人攻击。要真正成立「端到端加密」，必须让两端用户
// **带外**核对一段由双方 DTLS 证书指纹派生的短串（emoji / 数字）。
//
// 本模块只负责「从两端指纹派生稳定、顺序无关的 SAS」；带外核对由 UI 呈现。
//
// 哈希用纯 JS 的 sha256（见 crypto.ts）而非 crypto.subtle：后者在明文 http
// 下不存在，会让 SAS 在最需要它的场景里恰好失效。改为同步实现后 computeSas
// 不再可能因环境而失败。

import { sha256Hex } from './crypto'

/** 从一段 SDP 中提取 DTLS 证书指纹（sha-256）。 */
export function extractFingerprint(sdp: string | undefined | null): string | null {
  if (!sdp) return null
  const m = sdp.match(/a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/)
  return m ? m[1].toUpperCase() : null
}

/** 供带外核对的 SAS 结果：emoji 串 + 等价数字串。 */
export interface Sas {
  emoji: string[]
  digits: string
}

// 64 个视觉上易区分的 emoji；6 bit/个。顺序即索引，切勿随意重排。
const EMOJI = [
  '🐶', '🐱', '🐭', '🦊', '🐻', '🐼', '🐨', '🐯',
  '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦',
  '🦆', '🦉', '🐴', '🦄', '🐝', '🦋', '🐢', '🐙',
  '🐬', '🐳', '🐟', '🦀', '🌸', '🌻', '🌵', '🍀',
  '🍎', '🍊', '🍋', '🍉', '🍇', '🍓', '🍑', '🍍',
  '🥑', '🌽', '🍄', '🥕', '🍔', '🍕', '🌮', '🍩',
  '☕', '🍺', '⚽', '🏀', '🎸', '🎺', '🎨', '🚗',
  '✈️', '🚀', '⛵', '🏰', '⛺', '🎁', '💡', '🔑',
]

/**
 * 从两端指纹派生 SAS。对指纹排序后再哈希，保证两端得到完全相同的结果
 * （与谁是主叫无关）。取摘要前若干字节映射到 emoji 与十进制数字。
 *
 * 同步实现，任何上下文都能算（调用方沿用 await 亦无妨）。
 */
export function computeSas(fpA: string, fpB: string, emojiCount = 5): Sas {
  const [x, y] = [fpA.toUpperCase(), fpB.toUpperCase()].sort()
  const hex = sha256Hex(new TextEncoder().encode(`pphub-sas-v1|${x}|${y}`))
  const buf = new Uint8Array(32)
  for (let i = 0; i < 32; i++) buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)

  const emoji: string[] = []
  for (let i = 0; i < emojiCount; i++) {
    emoji.push(EMOJI[buf[i] & 0x3f])
  }

  // 6 位十进制作为无 emoji 环境的等价核对串。
  const num = (buf[0] << 16) | (buf[1] << 8) | buf[2]
  const digits = (num % 1_000_000).toString().padStart(6, '0')

  return { emoji, digits }
}
