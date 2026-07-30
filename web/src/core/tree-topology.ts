// 树状网络拓扑：通过构建生成树并限制节点度数，解决单点负载过高的问题。
// 参考 OSPF 和 Spanning Tree Protocol 的设计。
//
// 核心特性：
//   - 每个节点最多 maxDegree 个连接（默认 8）
//   - 树高 O(log n)，延迟可控
//   - 节点下线时自动重组子树
//   - LSA 泛洪 + Dijkstra 最短路径路由
//
// 拓扑示例（maxDegree=3）：
//        Root
//       /  |  \
//     N1  N2  N3
//    / \  |   / \
//   N4 N5 N6 N7 N8

import { Emitter } from './emitter'

/** 节点在树中的角色 */
export type TreeRole = 'root' | 'intermediate' | 'leaf'

/** 节点质量指标 */
export interface NodeQuality {
  /** 带宽估计（0-1，越高越好） */
  bandwidth: number
  /** 稳定性评分（基于在线时长，0-1） */
  stability: number
  /** 平均延迟（ms，越低越好） */
  latency: number
  /** 丢包率（0-1，越低越好） */
  packetLoss: number
  /** 综合评分（0-1） */
  score: number
}

/** 树节点 */
export interface TreeNode {
  id: string
  parent: string | null
  children: Set<string>
  level: number
  capacity: number
  maxDegree: number
  quality: NodeQuality
  lastHeartbeat: number
  role: TreeRole
}

/** Link State Advertisement */
export interface LSA {
  nodeId: string
  sequence: number
  age: number
  timestamp: number
  links: Array<{
    neighbor: string
    cost: number
    capacity: number
  }>
  quality: NodeQuality
}

/** 路由表条目 */
export interface RouteEntry {
  destination: string
  nextHop: string
  distance: number
  path: string[]
}

/** 树配置 */
export interface TreeTopologyConfig {
  maxDegree: number
  minDegree: number
  heartbeatInterval: number
  failureTimeout: number
  lsaInterval: number
  rebalanceInterval: number
  maxDepthRatio: number
}

const DEFAULT_CONFIG: TreeTopologyConfig = {
  maxDegree: 8,
  minDegree: 2,
  heartbeatInterval: 2000,
  failureTimeout: 6000,
  lsaInterval: 10000,
  rebalanceInterval: 30000,
  maxDepthRatio: 2.0,
}

type TreeTopologyEvents = {
  'root-change': { oldRoot?: string; newRoot: string }
  'parent-change': { nodeId: string; oldParent?: string; newParent: string }
  'tree-update': void
  'mount-required': { parent: string }
  'unmount-required': { child: string }
}

export class TreeTopology extends Emitter<TreeTopologyEvents> {
  private myId = ''
  private config: TreeTopologyConfig

  // 树结构
  private nodes = new Map<string, TreeNode>()
  private myParent: string | null = null
  private myChildren = new Set<string>()
  private root: string | null = null
  private myLevel = 0

  // LSA 数据库
  private lsaDatabase = new Map<string, LSA>()
  private lsaSequence = 0

  // 路由表
  private routingTable = new Map<string, RouteEntry>()

  // 心跳
  private lastHeartbeat = new Map<string, number>()
  private heartbeatSeq = 0

  // 定时器
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lsaTimer: ReturnType<typeof setInterval> | null = null
  private rebalanceTimer: ReturnType<typeof setInterval> | null = null
  private failureCheckTimer: ReturnType<typeof setInterval> | null = null

  // 根选举
  private electionTerm = 0

  constructor(config?: Partial<TreeTopologyConfig>) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 初始化为独立节点 */
  initialize(myId: string, quality: NodeQuality): void {
    this.myId = myId

    // 创建自己的节点
    this.nodes.set(myId, {
      id: myId,
      parent: null,
      children: new Set(),
      level: 0,
      capacity: this.config.maxDegree,
      maxDegree: this.config.maxDegree,
      quality,
      lastHeartbeat: Date.now(),
      role: 'root',
    })

    // 初始状态：自己是根
    this.root = myId
    this.myLevel = 0

    // 启动定时器
    this.startTimers()
  }

  /** 添加对等节点的质量信息 */
  addPeer(peerId: string, quality: NodeQuality, _rtt: number): void {
    if (this.nodes.has(peerId)) return

    this.nodes.set(peerId, {
      id: peerId,
      parent: null,
      children: new Set(),
      level: -1,
      capacity: this.config.maxDegree,
      maxDegree: this.config.maxDegree,
      quality,
      lastHeartbeat: Date.now(),
      role: 'leaf',
    })

    // 尝试将其挂载到树上
    this.tryMountNode(peerId)
  }

  /** 移除节点 */
  removePeer(peerId: string): void {
    const node = this.nodes.get(peerId)
    if (!node) return

    // 如果是根节点下线
    if (peerId === this.root) {
      this.handleRootFailure()
      return
    }

    // 如果是父节点下线
    if (peerId === this.myParent) {
      this.handleParentFailure()
      return
    }

    // 如果是子节点下线
    if (this.myChildren.has(peerId)) {
      this.handleChildFailure(peerId)
      return
    }

    // 其他节点：从树中移除
    this.removeFromTree(peerId)
  }

  /** 更新节点质量 */
  updateQuality(peerId: string, quality: Partial<NodeQuality>, rtt?: number): void {
    const node = this.nodes.get(peerId)
    if (!node) return

    // 更新质量数据
    Object.assign(node.quality, quality)
    node.quality.score = this.calculateQualityScore(node.quality)

    // 如果 RTT 发生显著变化，可能需要重组树
    if (rtt !== undefined) {
      this.considerRebalance()
    }
  }

  /** 获取当前角色 */
  getMyRole(): TreeRole {
    return this.nodes.get(this.myId)?.role ?? 'leaf'
  }

  /** 获取根节点 */
  getRoot(): string | null {
    return this.root
  }

  /** 是否是根节点 */
  isRoot(): boolean {
    return this.myId === this.root
  }

  /** 获取父节点 */
  getParent(): string | null {
    return this.myParent
  }

  /** 获取子节点列表 */
  getChildren(): Set<string> {
    return new Set(this.myChildren)
  }

  /** 获取树的层级 */
  getLevel(): number {
    return this.myLevel
  }

  /** 获取需要维持连接的节点 */
  getRequiredConnections(): Set<string> {
    const required = new Set<string>()

    // 父节点
    if (this.myParent) {
      required.add(this.myParent)
    }

    // 所有子节点
    for (const child of this.myChildren) {
      required.add(child)
    }

    return required
  }

  /** 获取到目标节点的下一跳 */
  getNextHop(destination: string): string | null {
    const route = this.routingTable.get(destination)
    return route?.nextHop ?? null
  }

  /** 获取路由表 */
  getRoutingTable(): Map<string, RouteEntry> {
    return new Map(this.routingTable)
  }

  /** 获取树的统计信息 */
  getStats() {
    const treeSize = this.nodes.size
    const maxDepth = this.getMaxDepth()
    const avgDepth = this.getAvgDepth()

    return {
      treeSize,
      myLevel: this.myLevel,
      myRole: this.getMyRole(),
      isRoot: this.isRoot(),
      root: this.root,
      parent: this.myParent,
      childCount: this.myChildren.size,
      capacity: this.nodes.get(this.myId)?.capacity ?? 0,
      maxDepth,
      avgDepth,
      routeCount: this.routingTable.size,
    }
  }

  /** 生成 LSA */
  generateLSA(): LSA {
    const myNode = this.nodes.get(this.myId)!
    const links: LSA['links'] = []

    // 添加父节点链接
    if (this.myParent) {
      links.push({
        neighbor: this.myParent,
        cost: this.getRouteCost(this.myParent),
        capacity: this.nodes.get(this.myParent)?.capacity ?? 0,
      })
    }

    // 添加子节点链接
    for (const child of this.myChildren) {
      links.push({
        neighbor: child,
        cost: this.getRouteCost(child),
        capacity: this.nodes.get(child)?.capacity ?? 0,
      })
    }

    return {
      nodeId: this.myId,
      sequence: ++this.lsaSequence,
      age: 0,
      timestamp: Date.now(),
      links,
      quality: myNode.quality,
    }
  }

  /** 处理收到的 LSA */
  handleLSA(lsa: LSA): boolean {
    const existing = this.lsaDatabase.get(lsa.nodeId)

    // 检查是否是更新的信息
    if (existing && existing.sequence >= lsa.sequence) {
      return false // 旧信息
    }

    // 更新数据库
    this.lsaDatabase.set(lsa.nodeId, lsa)

    // 更新节点信息
    const node = this.nodes.get(lsa.nodeId)
    if (node) {
      node.quality = lsa.quality
    }

    // 重新计算路由表
    this.recalculateRoutingTable()

    return true // 新信息，需要转发
  }

  /** 处理心跳消息 */
  handleHeartbeat(from: string, _sequence: number, quality: NodeQuality): void {
    this.lastHeartbeat.set(from, Date.now())

    const node = this.nodes.get(from)
    if (node) {
      node.quality = quality
      node.lastHeartbeat = Date.now()
    }
  }

  /** 请求挂载到父节点 */
  requestMount(parentId: string): boolean {
    const parent = this.nodes.get(parentId)
    if (!parent || parent.capacity === 0) {
      return false
    }

    // 发送挂载请求（实际通过事件通知上层）
    this.emit('mount-required', { parent: parentId })
    return true
  }

  /** 接受子节点挂载 */
  acceptMount(childId: string): boolean {
    const myNode = this.nodes.get(this.myId)
    if (!myNode || myNode.capacity === 0) {
      return false
    }

    // 添加子节点
    this.myChildren.add(childId)
    myNode.capacity--

    const child = this.nodes.get(childId)
    if (child) {
      child.parent = this.myId
      child.level = this.myLevel + 1
    }

    // 更新角色
    this.updateMyRole()

    // 广播 LSA
    this.broadcastLSA()

    return true
  }

  /** 拒绝子节点挂载 */
  rejectMount(childId: string, reason: string): void {
    console.log(`[tree] Rejected mount from ${childId}: ${reason}`)
  }

  /** 清理资源 */
  dispose(): void {
    this.stopTimers()
    this.nodes.clear()
    this.lsaDatabase.clear()
    this.routingTable.clear()
    this.lastHeartbeat.clear()
  }

  // ==================== 私有方法 ====================

  /** 尝试将节点挂载到树上 */
  private tryMountNode(peerId: string): void {
    // 如果自己有容量，直接挂载
    const myNode = this.nodes.get(this.myId)
    if (myNode && myNode.capacity > 0) {
      this.acceptMount(peerId)
      return
    }

    // 否则，寻找其他有容量的节点
    const candidates = Array.from(this.nodes.values())
      .filter(n => n.capacity > 0 && n.id !== peerId)
      .sort((a, b) => {
        // 优先选择负载低、质量好的节点
        const scoreA = a.capacity / a.maxDegree + a.quality.score
        const scoreB = b.capacity / b.maxDegree + b.quality.score
        return scoreB - scoreA
      })

    if (candidates.length > 0) {
      // 通知该节点挂载
      this.emit('mount-required', { parent: candidates[0].id })
    }
  }

  /** 从树中移除节点 */
  private removeFromTree(peerId: string): void {
    const node = this.nodes.get(peerId)
    if (!node) return

    // 从父节点移除
    if (node.parent) {
      const parent = this.nodes.get(node.parent)
      if (parent) {
        parent.children.delete(peerId)
        parent.capacity++
      }
    }

    // 移除节点
    this.nodes.delete(peerId)
    this.lsaDatabase.delete(peerId)
    this.lastHeartbeat.delete(peerId)
  }

  /** 根节点下线处理 */
  private handleRootFailure(): void {
    console.warn('[tree] Root node failed, starting election')

    // 触发根选举
    this.electNewRoot()
  }

  /** 父节点下线处理 */
  private handleParentFailure(): void {
    console.warn('[tree] Parent node failed, reconnecting')

    this.myParent = null
    this.myLevel = -1

    // 策略1：尝试连接到祖父节点或叔叔节点
    const alternatives = this.findAlternativeParents()
    for (const altParent of alternatives) {
      if (this.requestMount(altParent)) {
        return
      }
    }

    // 策略2：成为新的局部根
    this.becomeLocalRoot()
  }

  /** 子节点下线处理 */
  private handleChildFailure(childId: string): void {
    console.log('[tree] Child node failed:', childId)

    // 从子节点列表移除
    this.myChildren.delete(childId)

    const myNode = this.nodes.get(this.myId)
    if (myNode) {
      myNode.capacity++
    }

    // 移除节点
    this.removeFromTree(childId)

    // 更新角色
    this.updateMyRole()

    // 广播 LSA
    this.broadcastLSA()
  }

  /** 选举新根 */
  private electNewRoot(): void {
    this.electionTerm++

    // 选择质量最好的节点
    const candidates = Array.from(this.nodes.values())
      .sort((a, b) => {
        if (Math.abs(a.quality.score - b.quality.score) > 0.1) {
          return b.quality.score - a.quality.score
        }
        return a.id.localeCompare(b.id)
      })

    if (candidates.length === 0) return

    const newRoot = candidates[0].id
    this.root = newRoot

    if (newRoot === this.myId) {
      // 我成为新根
      this.myParent = null
      this.myLevel = 0
      this.updateMyRole()
    }

    this.emit('root-change', { oldRoot: undefined, newRoot })
  }

  /** 成为局部根 */
  private becomeLocalRoot(): void {
    console.log('[tree] Becoming local root')

    this.myParent = null
    this.myLevel = 0

    // 如果没有其他根，我就是全局根
    if (!this.root || !this.nodes.has(this.root)) {
      this.root = this.myId
      this.emit('root-change', { newRoot: this.myId })
    }

    this.updateMyRole()
  }

  /** 寻找备选父节点 */
  private findAlternativeParents(): string[] {
    // 优先选择同级或上级节点
    return Array.from(this.nodes.values())
      .filter(n => n.id !== this.myId && n.capacity > 0 && n.level <= this.myLevel)
      .sort((a, b) => {
        // 按层级、容量、质量排序
        if (a.level !== b.level) return a.level - b.level
        if (a.capacity !== b.capacity) return b.capacity - a.capacity
        return b.quality.score - a.quality.score
      })
      .map(n => n.id)
  }

  /** 更新自己的角色 */
  private updateMyRole(): void {
    const myNode = this.nodes.get(this.myId)
    if (!myNode) return

    if (this.myId === this.root) {
      myNode.role = 'root'
    } else if (this.myChildren.size > 0) {
      myNode.role = 'intermediate'
    } else {
      myNode.role = 'leaf'
    }
  }

  /** 计算质量评分 */
  private calculateQualityScore(quality: NodeQuality): number {
    return (
      quality.stability * 0.4 +
      quality.bandwidth * 0.3 +
      (1 - quality.latency / 1000) * 0.2 +
      (1 - quality.packetLoss) * 0.1
    )
  }

  /** 获取路由代价 */
  private getRouteCost(_peerId: string): number {
    // 简化：使用固定代价，实际应该用 RTT
    return 10
  }

  /** 重新计算路由表（Dijkstra） */
  private recalculateRoutingTable(): void {
    const distances = new Map<string, number>()
    const previous = new Map<string, string>()
    const visited = new Set<string>()

    distances.set(this.myId, 0)

    while (visited.size < this.nodes.size) {
      // 找到未访问的最近节点
      let nearest: string | null = null
      let minDist = Infinity

      for (const [nodeId, dist] of distances) {
        if (!visited.has(nodeId) && dist < minDist) {
          nearest = nodeId
          minDist = dist
        }
      }

      if (!nearest) break

      visited.add(nearest)

      // 更新邻居距离
      const lsa = this.lsaDatabase.get(nearest)
      if (lsa) {
        for (const link of lsa.links) {
          const newDist = minDist + link.cost
          const oldDist = distances.get(link.neighbor) ?? Infinity

          if (newDist < oldDist) {
            distances.set(link.neighbor, newDist)
            previous.set(link.neighbor, nearest)
          }
        }
      }
    }

    // 构建路由表
    this.routingTable.clear()
    for (const [dest, dist] of distances) {
      if (dest === this.myId) continue

      // 回溯路径
      const path: string[] = []
      let current = dest
      while (current !== this.myId) {
        path.unshift(current)
        const prev = previous.get(current)
        if (!prev) break
        current = prev
      }

      if (path.length > 0) {
        this.routingTable.set(dest, {
          destination: dest,
          nextHop: path[0],
          distance: dist,
          path,
        })
      }
    }
  }

  /** 获取最大深度 */
  private getMaxDepth(): number {
    let maxDepth = 0
    for (const node of this.nodes.values()) {
      if (node.level > maxDepth) {
        maxDepth = node.level
      }
    }
    return maxDepth
  }

  /** 获取平均深度 */
  private getAvgDepth(): number {
    let totalDepth = 0
    let count = 0
    for (const node of this.nodes.values()) {
      if (node.level >= 0) {
        totalDepth += node.level
        count++
      }
    }
    return count > 0 ? totalDepth / count : 0
  }

  /** 考虑重平衡 */
  private considerRebalance(): void {
    const maxDepth = this.getMaxDepth()
    const theoreticalDepth = Math.log(this.nodes.size) / Math.log(this.config.maxDegree)

    if (maxDepth > theoreticalDepth * this.config.maxDepthRatio) {
      console.log('[tree] Tree imbalanced, consider rebuild')
      // 触发重平衡（待实现）
    }
  }

  /** 广播 LSA */
  private broadcastLSA(): void {
    // 由上层处理实际广播
    const lsa = this.generateLSA()
    console.log('[tree] LSA generated:', lsa)
  }

  // ==================== 定时器 ====================

  private startTimers(): void {
    // 心跳定时器
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeats(),
      this.config.heartbeatInterval,
    )

    // LSA 定时器
    this.lsaTimer = setInterval(() => this.broadcastLSA(), this.config.lsaInterval)

    // 故障检测定时器
    this.failureCheckTimer = setInterval(() => this.detectFailures(), 1000)

    // 重平衡定时器
    this.rebalanceTimer = setInterval(
      () => this.considerRebalance(),
      this.config.rebalanceInterval,
    )
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.lsaTimer) {
      clearInterval(this.lsaTimer)
      this.lsaTimer = null
    }
    if (this.failureCheckTimer) {
      clearInterval(this.failureCheckTimer)
      this.failureCheckTimer = null
    }
    if (this.rebalanceTimer) {
      clearInterval(this.rebalanceTimer)
      this.rebalanceTimer = null
    }
  }

  private sendHeartbeats(): void {
    // 由上层处理实际发送
    this.heartbeatSeq++
  }

  private detectFailures(): void {
    const now = Date.now()
    const timeout = this.config.failureTimeout

    // 检查父节点
    if (this.myParent) {
      const lastHb = this.lastHeartbeat.get(this.myParent) ?? 0
      if (now - lastHb > timeout) {
        this.handleParentFailure()
      }
    }

    // 检查子节点
    for (const child of this.myChildren) {
      const lastHb = this.lastHeartbeat.get(child) ?? 0
      if (now - lastHb > timeout) {
        this.handleChildFailure(child)
      }
    }
  }
}
