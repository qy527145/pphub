// 节点名片：昵称 + 头像（emoji 或用户小图），localStorage 持久化，
// rev 单调递增保证乱序到达时新值不被旧值覆盖。

import type { Avatar, Profile } from './messages'

const LS_PROFILE = 'pphub.profile'

/** emoji 头像可选集（默认从中随机）。 */
export const AVATAR_EMOJIS = [
  '🦊', '🐼', '🐸', '🐙', '🦄', '🐧', '🦉', '🐳',
  '🍀', '🌙', '⚡', '🔥', '🎧', '🎯', '🚀', '🛰️',
]

/** 头像底色可选集（两种主题下都可辨识）。 */
export const AVATAR_COLORS = [
  '#6c4bf4', '#00a693', '#e5484d', '#ff8a00',
  '#0f9d58', '#2f6fed', '#c333a9', '#7a8699',
]

export function randomAvatar(seed: string): Avatar {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  const pick = <T>(arr: T[], salt: number) => arr[Math.abs(hash + salt) % arr.length]
  return {
    kind: 'emoji',
    value: pick(AVATAR_EMOJIS, 7),
    color: pick(AVATAR_COLORS, 3),
  }
}

export function loadProfile(defaultNick: string): Profile {
  try {
    const raw = localStorage.getItem(LS_PROFILE)
    if (raw) {
      const p = JSON.parse(raw) as Profile
      if (p && typeof p.nick === 'string' && p.avatar && typeof p.rev === 'number') return p
    }
  } catch {
    /* 损坏则重建 */
  }
  const p: Profile = { nick: defaultNick, avatar: randomAvatar(defaultNick + Date.now()), rev: 1 }
  saveProfile(p)
  return p
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(LS_PROFILE, JSON.stringify(p))
  } catch {
    /* 存储满 / 隐私模式：忽略，仅本次会话生效 */
  }
}

/** 头像图片上限（dataURL 长度）；超出会拖慢 control 通道，提前压缩。 */
const AVATAR_MAX_DIM = 96
const AVATAR_MAX_DATAURL = 24 * 1024

/** 把用户选的图片压成 96×96 居中裁切的 JPEG dataURL。 */
export function imageToAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = AVATAR_MAX_DIM
      canvas.height = AVATAR_MAX_DIM
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('canvas 不可用'))
        return
      }
      // 居中方形裁切后缩放。
      const side = Math.min(img.naturalWidth, img.naturalHeight)
      const sx = (img.naturalWidth - side) / 2
      const sy = (img.naturalHeight - side) / 2
      ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_MAX_DIM, AVATAR_MAX_DIM)
      let quality = 0.85
      let out = canvas.toDataURL('image/jpeg', quality)
      while (out.length > AVATAR_MAX_DATAURL && quality > 0.3) {
        quality -= 0.15
        out = canvas.toDataURL('image/jpeg', quality)
      }
      if (out.length > AVATAR_MAX_DATAURL) {
        reject(new Error('图片过于复杂，请换一张'))
        return
      }
      resolve(out)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取图片'))
    }
    img.src = url
  })
}
