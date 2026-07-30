// 邀请管理器 - 负责游戏邀请的发送、接收、处理

import type { GameType } from './games'

export interface Invitation {
  inviteId: string
  fromPeerId: string
  toPeerId: string
  tableId: string
  tableNumber: string
  gameType: GameType
  message?: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'accepted' | 'declined' | 'expired'
}

export type InviteCallback = (invite: Invitation) => void

/**
 * 邀请管理器
 * 负责：
 * 1. 创建和发送邀请
 * 2. 接收和处理邀请
 * 3. 邀请过期管理
 * 4. 批量邀请
 */
export class InviteManager {
  private invites = new Map<string, Invitation>()
  private pendingInvites = new Map<string, Invitation[]>() // peerId -> invites
  private inviteCallbacks = new Map<string, InviteCallback>()
  private inviteTimeout = 5 * 60 * 1000 // 5分钟过期

  /**
   * 创建邀请
   */
  createInvite(
    fromPeerId: string,
    toPeerId: string,
    tableId: string,
    tableNumber: string,
    gameType: GameType,
    message?: string,
  ): Invitation {
    const inviteId = `invite_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const now = Date.now()

    const invite: Invitation = {
      inviteId,
      fromPeerId,
      toPeerId,
      tableId,
      tableNumber,
      gameType,
      message,
      createdAt: now,
      expiresAt: now + this.inviteTimeout,
      status: 'pending',
    }

    this.invites.set(inviteId, invite)

    // 添加到接收者的待处理列表
    const pending = this.pendingInvites.get(toPeerId) || []
    pending.push(invite)
    this.pendingInvites.set(toPeerId, pending)

    // 设置过期自动清理
    setTimeout(() => {
      this.expireInvite(inviteId)
    }, this.inviteTimeout)

    console.log('[InviteManager] 创建邀请:', inviteId, 'from', fromPeerId, 'to', toPeerId)

    return invite
  }

  /**
   * 批量发送邀请
   */
  createBatchInvites(
    fromPeerId: string,
    toPeerIds: string[],
    tableId: string,
    tableNumber: string,
    gameType: GameType,
    message?: string,
  ): Invitation[] {
    return toPeerIds.map(toPeerId =>
      this.createInvite(fromPeerId, toPeerId, tableId, tableNumber, gameType, message)
    )
  }

  /**
   * 接受邀请
   */
  acceptInvite(inviteId: string): Invitation | null {
    const invite = this.invites.get(inviteId)
    if (!invite || invite.status !== 'pending') {
      return null
    }

    if (Date.now() > invite.expiresAt) {
      this.expireInvite(inviteId)
      return null
    }

    invite.status = 'accepted'
    this.removeFromPending(invite.toPeerId, inviteId)

    console.log('[InviteManager] 接受邀请:', inviteId)

    return invite
  }

  /**
   * 拒绝邀请
   */
  declineInvite(inviteId: string): boolean {
    const invite = this.invites.get(inviteId)
    if (!invite || invite.status !== 'pending') {
      return false
    }

    invite.status = 'declined'
    this.removeFromPending(invite.toPeerId, inviteId)

    console.log('[InviteManager] 拒绝邀请:', inviteId)

    return true
  }

  /**
   * 获取用户的待处理邀请
   */
  getPendingInvites(peerId: string): Invitation[] {
    return this.pendingInvites.get(peerId) || []
  }

  /**
   * 获取邀请详情
   */
  getInvite(inviteId: string): Invitation | null {
    return this.invites.get(inviteId) || null
  }

  /**
   * 从分享链接解析邀请信息
   * 格式: ?table=1234 或 ?invite=inviteId
   */
  parseInviteLink(url: string): { tableNumber?: string; inviteId?: string } | null {
    try {
      const urlObj = new URL(url)
      const tableNumber = urlObj.searchParams.get('table')
      const inviteId = urlObj.searchParams.get('invite')

      if (tableNumber || inviteId) {
        return { tableNumber: tableNumber || undefined, inviteId: inviteId || undefined }
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * 生成分享链接
   */
  generateShareLink(tableNumber: string, baseUrl?: string): string {
    const base = baseUrl || window.location.origin + window.location.pathname
    return `${base}?table=${tableNumber}`
  }

  /**
   * 生成邀请链接（带邀请ID，可跳过密码验证）
   */
  generateInviteLink(inviteId: string, baseUrl?: string): string {
    const base = baseUrl || window.location.origin + window.location.pathname
    return `${base}?invite=${inviteId}`
  }

  /**
   * 注册邀请回调（当收到新邀请时触发）
   */
  onInviteReceived(peerId: string, callback: InviteCallback): void {
    this.inviteCallbacks.set(peerId, callback)
  }

  /**
   * 触发邀请回调
   */
  triggerInviteCallback(invite: Invitation): void {
    const callback = this.inviteCallbacks.get(invite.toPeerId)
    if (callback) {
      callback(invite)
    }
  }

  /**
   * 使邀请过期
   */
  private expireInvite(inviteId: string): void {
    const invite = this.invites.get(inviteId)
    if (!invite || invite.status !== 'pending') {
      return
    }

    invite.status = 'expired'
    this.removeFromPending(invite.toPeerId, inviteId)

    console.log('[InviteManager] 邀请过期:', inviteId)
  }

  /**
   * 从待处理列表中移除
   */
  private removeFromPending(peerId: string, inviteId: string): void {
    const pending = this.pendingInvites.get(peerId)
    if (!pending) return

    const filtered = pending.filter(inv => inv.inviteId !== inviteId)

    if (filtered.length === 0) {
      this.pendingInvites.delete(peerId)
    } else {
      this.pendingInvites.set(peerId, filtered)
    }
  }

  /**
   * 清理过期邀请
   */
  cleanupExpiredInvites(): void {
    const now = Date.now()

    for (const [inviteId, invite] of this.invites.entries()) {
      if (invite.status === 'pending' && now > invite.expiresAt) {
        this.expireInvite(inviteId)
      }

      // 清理已完成的邀请（1小时后）
      if (invite.status !== 'pending' && now - invite.createdAt > 60 * 60 * 1000) {
        this.invites.delete(inviteId)
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const invitesByStatus = {
      pending: 0,
      accepted: 0,
      declined: 0,
      expired: 0,
    }

    for (const invite of this.invites.values()) {
      invitesByStatus[invite.status]++
    }

    return {
      totalInvites: this.invites.size,
      ...invitesByStatus,
      totalPending: Array.from(this.pendingInvites.values())
        .reduce((sum, invites) => sum + invites.length, 0),
    }
  }
}

// 单例导出
export const inviteManager = new InviteManager()

// 定期清理过期邀请
if (typeof window !== 'undefined') {
  setInterval(() => {
    inviteManager.cleanupExpiredInvites()
  }, 30 * 1000) // 每30秒清理一次
}
