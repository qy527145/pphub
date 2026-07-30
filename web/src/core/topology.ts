// 分层网络拓扑管理：实现分组、组长选举、智能路由，将全连接网络从 O(n²) 优化到 O(n)。
//
// 核心思想：
//   - 同一局域网（低延迟）的节点分为一组，组内全连接
//   - 不同组之间通过组长节点中继消息
//   - 服务端只需中继组长之间的流量
//
// 拓扑示例：
//   局域网A (4节点)          局域网B (2节点)
//       A1* (组长) ◄────────► B1* (组长)
//      / | \                    |
//    A2 A3 A4                  B2
//   组内全连接              组内直连

import { Emitter } from './emitter'

/** 拓扑运行模式 */
export type TopologyMode = 'full-mesh' | 'hierarchical'

/** 连接质量指标 */
export interface QualityMetrics {
  /** 往返延迟（ms） */
  rtt: number
  /** 丢包率（0-1） */
  packetLoss: number
  /** 抖动（ms） */
  jitter: number
  /** ICE 候选类型 */
  iceType: 'host' | 'srflx' | 'relay' | 'unknown'
  /** 连接状态 */
  state: RTCPeerConnectionState
  /** 最后更新时间 */
  lastUpdate: number
}

/** 网络分组 */
export interface NetworkGroup {
  /** 组ID（通常是首个成员的 peerId） */
  id: string
  /** 当前组长 */
  leader: string
  /** 所有成员 */
  members: Set<string>
  /** 备选组长列表（按优先级排序） */
  candidates: string[]
  /** 组内平均延迟 */
  avgRtt: number
  /** 上次选举时间戳 */
  lastElection: number
  /** 创建时间 */
  createdAt: number
}

/** 拓扑消息类型 */
export interface TopologyAnnounce {
  kind: 'topo-announce'
  /** 发送者的组ID */
  groupId: string
  /** 发送者所在组的组长 */
  leader: string
  /** 组员列表 */
  members: string[]
  /** 当前拓扑版本号 */
  version: number
}

export interface LeaderElect {
  kind: 'leader-elect'
  groupId: string
  /** 候选组长 */
  candidate: string
  /** 选举轮次 */
  term: number
}

export interface LeaderAck {
  kind: 'leader-ack'
  groupId: string
  leader: string
  term: number
}

export type TopologyMessage = TopologyAnnounce | LeaderElect | LeaderAck

type TopologyEvents = {
  /** 拓扑模式变化 */
  'mode-change': TopologyMode
  /** 分组结构变化 */
  'groups-update': NetworkGroup[]
  /** 本节点的组长变化 */
  'leader-change': { groupId: string; oldLeader?: string; newLeader: string }
  /** 需要建立新连接 */
  'connect-peer': string
  /** 可以断开的连接 */
  'disconnect-peer': string
}

/** 分组阈值配置 */
interface GroupingThresholds {
  /** 同组判定的最大 RTT（ms） */
  maxRttForSameGroup: number
  /** 最小组大小（避免过度分组） */
  minGroupSize: number
  /** 最大组大小 */
  maxGroupSize: number
  /** 拓扑重评估间隔（ms） */
  reevaluateInterval: number
  /** 组长心跳超时（ms） */
  leaderTimeout: number
}

const DEFAULT_THRESHOLDS: GroupingThresholds = {
  maxRttForSameGroup: 30, // 30ms 内认为在同一局域网
  minGroupSize: 2,
  maxGroupSize: 20,
  reevaluateInterval: 60_000, // 每分钟重评估
  leaderTimeout: 15_000, // 15秒无心跳则认为组长下线
}

export class TopologyManager extends Emitter<TopologyEvents> {
  /** 当前拓扑模式 */
  private mode: TopologyMode = 'full-mesh'
  /** 本节点 ID */
  private myId = ''
  /** 所有分组 */
  private groups = new Map<string, NetworkGroup>()
  /** peerId → groupId 映射 */
  private peerGroups = new Map<string, string>()
  /** 连接质量数据 */
  private qualities = new Map<string, QualityMetrics>()
  /** 拓扑版本号（每次重组递增） */
  private version = 0
  /** 配置阈值 */
  private thresholds: GroupingThresholds
  /** 重评估定时器 */
  private reevalTimer: ReturnType<typeof setInterval> | null = null
  /** 组长心跳定时器 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** 最后收到各组长心跳的时间 */
  private leaderHeartbeats = new Map<string, number>()
  /** 当前选举轮次 */
  private electionTerm = 0

  constructor(thresholds?: Partial<GroupingThresholds>) {
    super()
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
  }

  /** 初始化拓扑管理器 */
  initialize(myId: string, mode: TopologyMode = 'hierarchical'): void {
    this.myId = myId
    this.setMode(mode)

    // 启动定期重评估
    if (this.reevalTimer) clearInterval(this.reevalTimer)
    this.reevalTimer = setInterval(
      () => this.reevaluateTopology(),
      this.thresholds.reevaluateInterval,
    )

    // 启动组长健康检查
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => this.checkLeaderHealth(), 5000)
  }

  /** 设置拓扑模式 */
  setMode(mode: TopologyMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.emit('mode-change', mode)
    if (mode === 'hierarchical') {
      // 切换到分层模式：立即重新分组
      this.reevaluateTopology()
    } else {
      // 切换到全连接模式：清除分组信息
      this.groups.clear()
      this.peerGroups.clear()
    }
  }

  /** 获取当前模式 */
  getMode(): TopologyMode {
    return this.mode
  }

  /** 更新节点的连接质量数据 */
  updateQuality(peerId: string, metrics: Partial<QualityMetrics>): void {
    const existing = this.qualities.get(peerId)
    const updated: QualityMetrics = {
      rtt: metrics.rtt ?? existing?.rtt ?? Infinity,
      packetLoss: metrics.packetLoss ?? existing?.packetLoss ?? 0,
      jitter: metrics.jitter ?? existing?.jitter ?? 0,
      iceType: metrics.iceType ?? existing?.iceType ?? 'unknown',
      state: metrics.state ?? existing?.state ?? 'new',
      lastUpdate: Date.now(),
    }
    this.qualities.set(peerId, updated)

    // 连接质量显著变化：触发重评估
    if (existing && Math.abs(existing.rtt - updated.rtt) > 50) {
      this.scheduleReevaluation()
    }
  }

  /** 移除节点 */
  removePeer(peerId: string): void {
    this.qualities.delete(peerId)
    const groupId = this.peerGroups.get(peerId)
    if (!groupId) return

    const group = this.groups.get(groupId)
    if (!group) return

    group.members.delete(peerId)
    this.peerGroups.delete(peerId)

    // 如果移除的是组长：立即重新选举
    if (group.leader === peerId) {
      this.electLeader(group)
    }

    // 组内只剩一个人：解散该组
    if (group.members.size === 0) {
      this.groups.delete(groupId)
    } else if (group.members.size === 1) {
      // 尝试合并到其他组
      this.tryMergeSmallGroup(group)
    }

    this.emit('groups-update', this.getGroupsList())
  }

  /** 获取指定节点的组ID */
  getGroupId(peerId: string): string | undefined {
    return this.peerGroups.get(peerId)
  }

  /** 获取指定节点的组长 */
  getLeader(peerId: string): string | undefined {
    const groupId = this.peerGroups.get(peerId)
    if (!groupId) return undefined
    return this.groups.get(groupId)?.leader
  }

  /** 判断两个节点是否在同一组 */
  inSameGroup(peer1: string, peer2: string): boolean {
    const g1 = this.peerGroups.get(peer1)
    const g2 = this.peerGroups.get(peer2)
    return !!g1 && g1 === g2
  }

  /** 本节点是否是组长 */
  isLeader(): boolean {
    const myGroupId = this.peerGroups.get(this.myId)
    if (!myGroupId) return false
    const group = this.groups.get(myGroupId)
    return group?.leader === this.myId
  }

  /** 获取本节点的组长 */
  getMyLeader(): string | undefined {
    return this.getLeader(this.myId)
  }

  /** 获取所有组长列表 */
  getLeaders(): string[] {
    return Array.from(this.groups.values()).map((g) => g.leader)
  }

  /** 获取应该保持连接的节点列表 */
  getRequiredConnections(): Set<string> {
    if (this.mode === 'full-mesh') {
      // 全连接模式：与所有人连接
      return new Set(this.qualities.keys())
    }

    // 分层模式：同组所有人 + 其他组的组长
    const required = new Set<string>()
    const myGroupId = this.peerGroups.get(this.myId)
    const myGroup = myGroupId ? this.groups.get(myGroupId) : undefined

    if (myGroup) {
      // 同组的所有成员
      for (const member of myGroup.members) {
        if (member !== this.myId) required.add(member)
      }

      // 如果我是组长：连接其他所有组长
      if (this.isLeader()) {
        for (const group of this.groups.values()) {
          if (group.id !== myGroupId && group.leader !== this.myId) {
            required.add(group.leader)
          }
        }
      } else {
        // 如果我是组员：只连接我的组长
        if (myGroup.leader !== this.myId) {
          required.add(myGroup.leader)
        }
      }
    }

    return required
  }

  /** 处理拓扑通告消息 */
  handleTopologyAnnounce(_from: string, msg: TopologyAnnounce): void {
    // 记录组长心跳
    this.leaderHeartbeats.set(msg.leader, Date.now())

    // 更新远端组信息（用于网络视图展示）
    // 暂不主动调整本地分组，避免频繁震荡
  }

  /** 处理组长选举消息 */
  handleLeaderElect(from: string, msg: LeaderElect): void {
    const group = this.groups.get(msg.groupId)
    if (!group || !group.members.has(from)) return

    // 只响应更高轮次的选举
    if (msg.term <= this.electionTerm) return

    this.electionTerm = msg.term
    // 确认新组长
    const oldLeader = group.leader
    group.leader = msg.candidate
    group.lastElection = Date.now()

    this.emit('leader-change', {
      groupId: msg.groupId,
      oldLeader: oldLeader !== msg.candidate ? oldLeader : undefined,
      newLeader: msg.candidate,
    })
  }

  /** 生成拓扑通告消息（组长定期广播） */
  generateAnnounce(): TopologyAnnounce | null {
    if (!this.isLeader()) return null
    const myGroupId = this.peerGroups.get(this.myId)
    const myGroup = myGroupId ? this.groups.get(myGroupId) : undefined
    if (!myGroup) return null

    return {
      kind: 'topo-announce',
      groupId: myGroup.id,
      leader: myGroup.leader,
      members: Array.from(myGroup.members),
      version: this.version,
    }
  }

  /** 获取所有分组列表（用于 UI 展示） */
  getGroupsList(): NetworkGroup[] {
    return Array.from(this.groups.values())
  }

  /** 获取网络统计信息 */
  getStats(): {
    mode: TopologyMode
    totalPeers: number
    totalGroups: number
    avgGroupSize: number
    myGroupSize: number
    isLeader: boolean
    requiredConnections: number
  } {
    const myGroupId = this.peerGroups.get(this.myId)
    const myGroup = myGroupId ? this.groups.get(myGroupId) : undefined

    return {
      mode: this.mode,
      totalPeers: this.qualities.size,
      totalGroups: this.groups.size,
      avgGroupSize:
        this.groups.size > 0
          ? Array.from(this.groups.values()).reduce((sum, g) => sum + g.members.size, 0) /
            this.groups.size
          : 0,
      myGroupSize: myGroup?.members.size ?? 0,
      isLeader: this.isLeader(),
      requiredConnections: this.getRequiredConnections().size,
    }
  }

  /** 清理资源 */
  dispose(): void {
    if (this.reevalTimer) {
      clearInterval(this.reevalTimer)
      this.reevalTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.groups.clear()
    this.peerGroups.clear()
    this.qualities.clear()
    this.leaderHeartbeats.clear()
  }

  // ==================== 私有方法 ====================

  /** 重新评估拓扑并分组 */
  private reevaluateTopology(): void {
    if (this.mode !== 'hierarchical') return
    if (this.qualities.size === 0) return

    // 基于 RTT 进行聚类分组
    const newGroups = this.clusterByRtt()

    // 对比新旧分组，计算变化
    const changes = this.computeGroupChanges(newGroups)

    // 应用变化
    this.applyGroupChanges(changes)

    this.version++
    this.emit('groups-update', this.getGroupsList())
  }

  /** 基于 RTT 进行聚类分组 */
  private clusterByRtt(): Map<string, Set<string>> {
    const peers = Array.from(this.qualities.keys())
    if (peers.length === 0) return new Map()

    // 简化版聚类：贪心算法
    // 1. 按 RTT 排序
    // 2. 从本节点开始，找所有低延迟邻居作为一组
    // 3. 剩余节点递归分组

    const groups = new Map<string, Set<string>>()
    const assigned = new Set<string>()

    // 确保本节点优先分配
    const sortedPeers = [this.myId, ...peers.filter((p) => p !== this.myId)]

    for (const seed of sortedPeers) {
      if (assigned.has(seed)) continue

      const group = new Set<string>([seed])
      assigned.add(seed)

      // 找与 seed 低延迟的邻居
      for (const peer of peers) {
        if (assigned.has(peer)) continue
        if (group.size >= this.thresholds.maxGroupSize) break

        const rtt = this.getRttBetween(seed, peer)
        if (rtt < this.thresholds.maxRttForSameGroup) {
          group.add(peer)
          assigned.add(peer)
        }
      }

      // 组太小：尝试合并到最近的组
      if (group.size < this.thresholds.minGroupSize && groups.size > 0) {
        const nearest = this.findNearestGroup(seed, groups)
        if (nearest) {
          for (const member of group) nearest.add(member)
          continue
        }
      }

      groups.set(seed, group)
    }

    return groups
  }

  /** 获取两个节点之间的 RTT */
  private getRttBetween(peer1: string, peer2: string): number {
    if (peer1 === peer2) return 0
    if (peer1 === this.myId) return this.qualities.get(peer2)?.rtt ?? Infinity
    if (peer2 === this.myId) return this.qualities.get(peer1)?.rtt ?? Infinity
    // 间接 RTT 估算：RTT(A-C) ≈ RTT(A-B) + RTT(B-C)
    const rtt1 = this.qualities.get(peer1)?.rtt ?? Infinity
    const rtt2 = this.qualities.get(peer2)?.rtt ?? Infinity
    return rtt1 + rtt2
  }

  /** 找到与指定节点最近的组 */
  private findNearestGroup(
    peerId: string,
    groups: Map<string, Set<string>>,
  ): Set<string> | null {
    let minAvgRtt = Infinity
    let nearest: Set<string> | null = null

    for (const group of groups.values()) {
      if (group.size >= this.thresholds.maxGroupSize) continue

      let totalRtt = 0
      for (const member of group) {
        totalRtt += this.getRttBetween(peerId, member)
      }
      const avgRtt = totalRtt / group.size

      if (avgRtt < minAvgRtt && avgRtt < this.thresholds.maxRttForSameGroup * 2) {
        minAvgRtt = avgRtt
        nearest = group
      }
    }

    return nearest
  }

  /** 计算新旧分组的变化 */
  private computeGroupChanges(newGroups: Map<string, Set<string>>): {
    toAdd: Set<string> // 需要新建连接的节点
    toRemove: Set<string> // 可以断开连接的节点
    newGroupMap: Map<string, NetworkGroup>
  } {
    const oldRequired = this.getRequiredConnections()

    // 构建新的 NetworkGroup 对象
    const newGroupMap = new Map<string, NetworkGroup>()
    for (const [seed, members] of newGroups) {
      const groupId = seed // 用种子节点的 ID 作为组 ID
      const avgRtt = this.calculateAvgRtt(members)

      // 选举组长（字典序最小）
      const leader = Array.from(members).sort()[0]

      newGroupMap.set(groupId, {
        id: groupId,
        leader,
        members,
        candidates: Array.from(members).sort(),
        avgRtt,
        lastElection: Date.now(),
        createdAt: Date.now(),
      })
    }

    // 临时应用新分组以计算新的必需连接
    const oldGroups = this.groups
    const oldPeerGroups = this.peerGroups
    this.groups = newGroupMap
    this.peerGroups = new Map()
    for (const [groupId, group] of newGroupMap) {
      for (const member of group.members) {
        this.peerGroups.set(member, groupId)
      }
    }

    const newRequired = this.getRequiredConnections()

    // 恢复旧分组
    this.groups = oldGroups
    this.peerGroups = oldPeerGroups

    // 计算差异
    const toAdd = new Set<string>()
    const toRemove = new Set<string>()

    for (const peer of newRequired) {
      if (!oldRequired.has(peer)) toAdd.add(peer)
    }
    for (const peer of oldRequired) {
      if (!newRequired.has(peer)) toRemove.add(peer)
    }

    return { toAdd, toRemove, newGroupMap }
  }

  /** 应用分组变化 */
  private applyGroupChanges(changes: {
    toAdd: Set<string>
    toRemove: Set<string>
    newGroupMap: Map<string, NetworkGroup>
  }): void {
    // 更新分组结构
    this.groups = changes.newGroupMap
    this.peerGroups.clear()
    for (const [groupId, group] of changes.newGroupMap) {
      for (const member of group.members) {
        this.peerGroups.set(member, groupId)
      }
    }

    // 通知上层建立/断开连接
    for (const peer of changes.toAdd) {
      this.emit('connect-peer', peer)
    }
    for (const peer of changes.toRemove) {
      this.emit('disconnect-peer', peer)
    }
  }

  /** 计算组内平均 RTT */
  private calculateAvgRtt(members: Set<string>): number {
    if (members.size === 0) return 0
    let total = 0
    let count = 0
    for (const member of members) {
      if (member === this.myId) continue
      const rtt = this.qualities.get(member)?.rtt
      if (rtt !== undefined && rtt < Infinity) {
        total += rtt
        count++
      }
    }
    return count > 0 ? total / count : 0
  }

  /** 选举组长 */
  private electLeader(group: NetworkGroup): void {
    if (group.members.size === 0) return

    const oldLeader = group.leader
    // 简单策略：字典序最小
    group.leader = Array.from(group.members).sort()[0]
    group.lastElection = Date.now()
    this.electionTerm++

    if (oldLeader !== group.leader) {
      this.emit('leader-change', {
        groupId: group.id,
        oldLeader: oldLeader !== group.leader ? oldLeader : undefined,
        newLeader: group.leader,
      })
    }
  }

  /** 检查组长健康状态 */
  private checkLeaderHealth(): void {
    const now = Date.now()
    for (const group of this.groups.values()) {
      // 跳过本节点是组长的组
      if (group.leader === this.myId) continue

      const lastHeartbeat = this.leaderHeartbeats.get(group.leader) ?? 0
      if (now - lastHeartbeat > this.thresholds.leaderTimeout) {
        // 组长心跳超时：重新选举
        console.warn(`[topology] Leader ${group.leader} timeout, re-electing...`)
        this.electLeader(group)
      }
    }
  }

  /** 尝试合并小组到邻近的大组 */
  private tryMergeSmallGroup(smallGroup: NetworkGroup): void {
    if (smallGroup.members.size >= this.thresholds.minGroupSize) return

    const nearestGroup = this.findNearestExistingGroup(smallGroup)
    if (!nearestGroup) return

    // 合并到最近的组
    for (const member of smallGroup.members) {
      nearestGroup.members.add(member)
      this.peerGroups.set(member, nearestGroup.id)
    }
    this.groups.delete(smallGroup.id)

    // 重新计算合并后组的平均 RTT
    nearestGroup.avgRtt = this.calculateAvgRtt(nearestGroup.members)
  }

  /** 找到最近的现有组 */
  private findNearestExistingGroup(smallGroup: NetworkGroup): NetworkGroup | null {
    let minAvgRtt = Infinity
    let nearest: NetworkGroup | null = null

    for (const group of this.groups.values()) {
      if (group.id === smallGroup.id) continue
      if (group.members.size >= this.thresholds.maxGroupSize) continue

      let totalRtt = 0
      let count = 0
      for (const member1 of smallGroup.members) {
        for (const member2 of group.members) {
          totalRtt += this.getRttBetween(member1, member2)
          count++
        }
      }
      const avgRtt = count > 0 ? totalRtt / count : Infinity

      if (avgRtt < minAvgRtt) {
        minAvgRtt = avgRtt
        nearest = group
      }
    }

    return nearest
  }

  /** 延迟触发重评估（防抖） */
  private scheduleReevaluation = (() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    return () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => this.reevaluateTopology(), 2000)
    }
  })()
}
