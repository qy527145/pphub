// 游戏桌管理器 - 负责桌号生成、验证、生命周期管理

import type { GameTable, GameType } from './games'

export interface CreateTableConfig {
  gameType: GameType
  hostId: string
  visibility: 'public' | 'private'
  password?: string
  maxPlayers?: number
}

export interface TableNumberInfo {
  tableNumber: string
  tableId: string
  passwordHash?: string
  createdAt: number
}

/**
 * 游戏桌管理器
 * 负责：
 * 1. 桌号生成与分配
 * 2. 密码验证
 * 3. 桌子查询与过滤
 * 4. 桌子生命周期管理
 */
export class TableManager {
  private tables = new Map<string, GameTable>()
  private tableNumbers = new Map<string, TableNumberInfo>()
  private usedNumbers = new Set<string>()

  /**
   * 生成4-6位数字桌号
   * 优先生成4位，碰撞后递增到6位
   */
  generateTableNumber(retries = 0): string {
    const length = Math.min(4 + Math.floor(retries / 10), 6)
    const min = Math.pow(10, length - 1)
    const max = Math.pow(10, length) - 1

    let attempts = 0
    while (attempts < 100) {
      const number = Math.floor(Math.random() * (max - min + 1) + min).toString()
      if (!this.usedNumbers.has(number)) {
        this.usedNumbers.add(number)
        return number
      }
      attempts++
    }

    // 100次都碰撞，增加位数重试
    if (retries < 20) {
      return this.generateTableNumber(retries + 1)
    }

    throw new Error('无法生成可用桌号，请稍后重试')
  }

  /**
   * 创建游戏桌
   */
  createTable(config: CreateTableConfig): { table: GameTable; tableNumber: string } {
    const tableId = `table_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const tableNumber = this.generateTableNumber()

    const table: GameTable = {
      tableId,
      gameType: config.gameType,
      hostId: config.hostId,
      state: 'waiting',
      visibility: config.visibility,
      players: [config.hostId],
      spectators: [],
      config: {},
    }

    this.tables.set(tableId, table)

    const numberInfo: TableNumberInfo = {
      tableNumber,
      tableId,
      passwordHash: config.password ? this.hashPassword(config.password) : undefined,
      createdAt: Date.now(),
    }

    this.tableNumbers.set(tableNumber, numberInfo)

    return { table, tableNumber }
  }

  /**
   * 通过桌号查找桌子
   */
  getTableByNumber(tableNumber: string): GameTable | null {
    const info = this.tableNumbers.get(tableNumber)
    if (!info) return null
    return this.tables.get(info.tableId) || null
  }

  /**
   * 通过ID查找桌子
   */
  getTableById(tableId: string): GameTable | null {
    return this.tables.get(tableId) || null
  }

  /**
   * 验证密码
   */
  verifyPassword(tableNumber: string, password: string): boolean {
    const info = this.tableNumbers.get(tableNumber)
    if (!info) return false
    if (!info.passwordHash) return true // 无密码桌

    return this.hashPassword(password) === info.passwordHash
  }

  /**
   * 获取所有公开桌
   */
  getPublicTables(gameType?: GameType): GameTable[] {
    const tables = Array.from(this.tables.values())
      .filter(t => t.visibility === 'public')

    if (gameType) {
      return tables.filter(t => t.gameType === gameType)
    }

    return tables
  }

  /**
   * 获取等待中的公开桌（用于快速匹配）
   */
  getWaitingTables(gameType: GameType): GameTable[] {
    return this.getPublicTables(gameType)
      .filter(t => t.state === 'waiting')
      .sort((a, b) => b.players.length - a.players.length) // 人多的优先
  }

  /**
   * 更新桌子状态
   */
  updateTable(tableId: string, updates: Partial<GameTable>): boolean {
    const table = this.tables.get(tableId)
    if (!table) return false

    Object.assign(table, updates)
    return true
  }

  /**
   * 销毁桌子
   */
  destroyTable(tableId: string): void {
    const table = this.tables.get(tableId)
    if (!table) return

    // 找到并移除桌号
    for (const [number, info] of this.tableNumbers.entries()) {
      if (info.tableId === tableId) {
        this.tableNumbers.delete(number)
        // 延迟5分钟回收桌号，避免立即重用
        setTimeout(() => {
          this.usedNumbers.delete(number)
        }, 5 * 60 * 1000)
        break
      }
    }

    this.tables.delete(tableId)
  }

  /**
   * 获取桌号信息
   */
  getTableNumber(tableId: string): string | null {
    for (const [number, info] of this.tableNumbers.entries()) {
      if (info.tableId === tableId) {
        return number
      }
    }
    return null
  }

  /**
   * 注册远程创建的桌子（P2P 同步）
   */
  registerRemoteTable(tableId: string, tableNumber: string, passwordHash?: string): void {
    // 检查桌号是否已存在
    if (this.tableNumbers.has(tableNumber)) {
      console.warn('[TableManager] 桌号冲突，远程桌子将被忽略:', tableNumber)
      return
    }

    const info: TableNumberInfo = {
      tableNumber,
      tableId,
      passwordHash,
      createdAt: Date.now(),
    }

    this.tableNumbers.set(tableNumber, info)
    this.usedNumbers.add(tableNumber)

    console.log('[TableManager] 注册远程桌子:', tableNumber, '->', tableId)
  }

  /**
   * 清理过期桌子（30分钟无活动）
   */
  cleanupExpiredTables(): void {
    const now = Date.now()
    const timeout = 30 * 60 * 1000 // 30分钟

    for (const [tableId, table] of this.tables.entries()) {
      // 空桌子或长时间等待
      if (table.players.length === 0) {
        this.destroyTable(tableId)
        continue
      }

      // 游戏结束超过30分钟
      if (table.state === 'finished' && table.finishedAt) {
        if (now - table.finishedAt > timeout) {
          this.destroyTable(tableId)
        }
      }
    }
  }

  /**
   * 清空所有桌子与桌号（换房间/断连时调用，避免旧房间的桌子残留到新房间）。
   */
  reset(): void {
    this.tables.clear()
    this.tableNumbers.clear()
    this.usedNumbers.clear()
  }

  /**
   * 简单密码哈希（实际项目应使用 bcrypt）
   */
  private hashPassword(password: string): string {
    // 这里简化处理，实际应该用 crypto.subtle.digest
    return btoa(password) // 仅作演示
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalTables: this.tables.size,
      publicTables: this.getPublicTables().length,
      waitingTables: Array.from(this.tables.values()).filter(t => t.state === 'waiting').length,
      playingTables: Array.from(this.tables.values()).filter(t => t.state === 'playing').length,
      usedNumbers: this.usedNumbers.size,
    }
  }
}

// 单例导出
export const tableManager = new TableManager()

// 定期清理过期桌子
if (typeof window !== 'undefined') {
  setInterval(() => {
    tableManager.cleanupExpiredTables()
  }, 5 * 60 * 1000) // 每5分钟清理一次
}
