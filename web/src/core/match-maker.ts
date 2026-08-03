// 匹配器 - 负责快速匹配逻辑

import type { GameTable, GameType } from './games'
import { tableManager } from './table-manager'
import { getGameMeta, maxPlayersOf } from './games'

export interface MatchRequest {
  peerId: string
  gameType: GameType
  timestamp: number
}

/**
 * 匹配器
 * 负责：
 * 1. 快速匹配逻辑
 * 2. 匹配队列管理
 * 3. 自动创建/加入桌子
 */
export class MatchMaker {
  private matchQueues = new Map<GameType, MatchRequest[]>()
  private matchCallbacks = new Map<string, (table: GameTable | null) => void>()
  private matchTimeout = 60 * 1000 // 60秒超时

  /**
   * 快速匹配
   * 1. 先查找有空位的等待桌
   * 2. 如果没有，创建新桌并等待其他玩家
   * 3. 超时后返回 null
   */
  async quickMatch(
    peerId: string,
    gameType: GameType,
    onFound: (table: GameTable) => void,
    onCreate: () => GameTable,
  ): Promise<void> {
    // 查找等待中的公开桌
    const waitingTables = tableManager.getWaitingTables(gameType)
    const meta = getGameMeta(gameType)

    if (!meta) {
      throw new Error(`未知游戏类型: ${gameType}`)
    }

    // 找到有空位的桌子
    for (const table of waitingTables) {
      if (table.players.length < maxPlayersOf(meta)) {
        console.log('[MatchMaker] 找到等待桌:', table.tableId)
        onFound(table)
        return
      }
    }

    // 没有合适的桌子，创建新桌并等待
    console.log('[MatchMaker] 创建新桌等待匹配')
    onCreate()

    // 加入匹配队列
    this.addToQueue(peerId, gameType)

    // 设置超时
    const timeoutId = setTimeout(() => {
      console.log('[MatchMaker] 匹配超时')
      this.removeFromQueue(peerId, gameType)
      this.matchCallbacks.get(peerId)?.(null)
      this.matchCallbacks.delete(peerId)
    }, this.matchTimeout)

    // 等待其他玩家加入
    this.matchCallbacks.set(peerId, (table) => {
      clearTimeout(timeoutId)
      this.removeFromQueue(peerId, gameType)
      if (table) {
        onFound(table)
      }
    })
  }

  /**
   * 取消匹配
   */
  cancelMatch(peerId: string, gameType: GameType): void {
    this.removeFromQueue(peerId, gameType)
    const callback = this.matchCallbacks.get(peerId)
    if (callback) {
      callback(null)
      this.matchCallbacks.delete(peerId)
    }
  }

  /**
   * 加入匹配队列
   */
  addToQueue(peerId: string, gameType: GameType): void {
    const queue = this.matchQueues.get(gameType) || []

    // 避免重复加入
    if (queue.some(r => r.peerId === peerId)) {
      return
    }

    queue.push({
      peerId,
      gameType,
      timestamp: Date.now(),
    })

    this.matchQueues.set(gameType, queue)
    console.log('[MatchMaker] 加入匹配队列:', gameType, '队列长度:', queue.length)
  }

  /**
   * 从匹配队列移除
   */
  removeFromQueue(peerId: string, gameType: GameType): void {
    const queue = this.matchQueues.get(gameType)
    if (!queue) return

    const filtered = queue.filter(r => r.peerId !== peerId)

    if (filtered.length === 0) {
      this.matchQueues.delete(gameType)
    } else {
      this.matchQueues.set(gameType, filtered)
    }

    console.log('[MatchMaker] 离开匹配队列:', gameType, '剩余:', filtered.length)
  }

  /**
   * 获取队列中的等待者
   */
  getQueuedPlayers(gameType: GameType): MatchRequest[] {
    return this.matchQueues.get(gameType) || []
  }

  /**
   * 通知匹配成功
   */
  notifyMatch(peerId: string, table: GameTable): void {
    const callback = this.matchCallbacks.get(peerId)
    if (callback) {
      callback(table)
      this.matchCallbacks.delete(peerId)
    }
  }

  /**
   * 尝试匹配队列中的玩家
   * 当有新玩家加入等待桌时调用
   */
  tryMatchWaitingPlayers(table: GameTable): void {
    const queue = this.matchQueues.get(table.gameType)
    if (!queue || queue.length === 0) return

    const meta = getGameMeta(table.gameType)
    if (!meta) return

    // 如果桌子还有空位，通知队列中的第一个玩家
    if (table.players.length < maxPlayersOf(meta)) {
      const request = queue[0]
      if (request && request.peerId !== table.hostId) {
        this.notifyMatch(request.peerId, table)
      }
    }
  }

  /**
   * 清理过期的匹配请求
   */
  cleanupExpiredRequests(): void {
    const now = Date.now()

    for (const [gameType, queue] of this.matchQueues.entries()) {
      const filtered = queue.filter(r => now - r.timestamp < this.matchTimeout)

      if (filtered.length === 0) {
        this.matchQueues.delete(gameType)
      } else if (filtered.length !== queue.length) {
        this.matchQueues.set(gameType, filtered)
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const totalWaiting = Array.from(this.matchQueues.values())
      .reduce((sum, queue) => sum + queue.length, 0)

    return {
      totalQueues: this.matchQueues.size,
      totalWaiting,
      queuesByGame: Array.from(this.matchQueues.entries()).map(([gameType, queue]) => ({
        gameType,
        count: queue.length,
      })),
    }
  }
}

// 单例导出
export const matchMaker = new MatchMaker()

// 定期清理过期请求
if (typeof window !== 'undefined') {
  setInterval(() => {
    matchMaker.cleanupExpiredRequests()
  }, 10 * 1000) // 每10秒清理一次
}
