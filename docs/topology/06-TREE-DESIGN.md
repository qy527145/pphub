# 树状拓扑优化设计 v2.0

## 问题分析

### 当前架构的瓶颈
```
局域网内 100 个节点的情况：
    组长 A1
   /  |  \  ... (99 个连接)
 A2  A3  A4 ... A100

问题：
- 组长需要维护 99 个连接（负载过高）
- 组长下线时，所有节点失去连接
- 没有考虑单节点连接能力上限
```

### 优化目标
```
树状结构（最大度数限制）：
        A1 (根/组长)
       /  |  \
     A2  A3  A4  (子组长)
    / |  / \  | \
  A5 A6 A7 A8 A9 A10 ...

优势：
- 每个节点最多 maxDegree 个连接
- 树高 log(n)，延迟可控
- 父节点下线时，子树可以重组
```

## 核心设计

### 1. 动态树构建（参考 OSPF）

#### 节点状态
```typescript
interface TreeNode {
  id: string
  parent: string | null         // 父节点
  children: Set<string>         // 子节点
  level: number                 // 树中的层级（根为0）
  capacity: number              // 剩余连接容量
  maxDegree: number            // 最大连接数
  quality: NodeQuality         // 节点质量评分
  lastHeartbeat: number        // 最后心跳时间
}

interface NodeQuality {
  bandwidth: number            // 带宽估计
  stability: number            // 稳定性评分（在线时长）
  latency: number             // 平均延迟
  packetLoss: number          // 丢包率
  score: number               // 综合评分
}
```

#### 树构建算法
```typescript
// 基于 Prim 最小生成树 + 度数限制
function buildTree(nodes: Map<string, NodeMetrics>): Tree {
  // 1. 选择根节点（质量最好的节点）
  const root = selectRoot(nodes)
  
  // 2. 优先队列：按质量和距离排序
  const queue = new PriorityQueue<{
    node: string
    parent: string
    cost: number  // RTT + 父节点负载惩罚
  }>()
  
  // 3. 逐个添加节点
  while (queue.notEmpty()) {
    const { node, parent } = queue.pop()
    
    // 检查父节点容量
    if (tree.getNode(parent).capacity === 0) {
      // 父节点已满，寻找兄弟节点
      parent = findAlternativeParent(node, tree)
    }
    
    tree.addEdge(parent, node)
    
    // 将邻居节点加入队列
    for (const neighbor of getNeighbors(node)) {
      if (!tree.contains(neighbor)) {
        queue.push({
          node: neighbor,
          parent: node,
          cost: calculateCost(node, neighbor, tree)
        })
      }
    }
  }
  
  return tree
}

// 代价函数：RTT + 负载惩罚
function calculateCost(
  parent: string,
  child: string,
  tree: Tree
): number {
  const rtt = getRTT(parent, child)
  const parentNode = tree.getNode(parent)
  
  // 负载惩罚：容量越少，代价越高
  const loadPenalty = (1 - parentNode.capacity / parentNode.maxDegree) * 100
  
  // 深度惩罚：避免树过深
  const depthPenalty = parentNode.level * 10
  
  return rtt + loadPenalty + depthPenalty
}
```

### 2. 根节点选举（参考 OSPF Router ID）

#### 选举策略
```typescript
function electRoot(nodes: Map<string, TreeNode>): string {
  // 综合评分：稳定性 > 带宽 > 延迟 > peerId
  const scored = Array.from(nodes.values())
    .map(node => ({
      id: node.id,
      score: calculateNodeScore(node)
    }))
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.1) {
        return b.score - a.score  // 分数高的优先
      }
      return a.id.localeCompare(b.id)  // 分数相同按 ID 字典序
    })
  
  return scored[0].id
}

function calculateNodeScore(node: TreeNode): number {
  const quality = node.quality
  
  // 权重：稳定性 40%，带宽 30%，延迟 20%，丢包 10%
  return (
    quality.stability * 0.4 +
    quality.bandwidth * 0.3 +
    (1 - quality.latency / 1000) * 0.2 +
    (1 - quality.packetLoss) * 0.1
  )
}
```

### 3. 节点下线恢复（参考 RIP 路由更新）

#### 场景 1：叶子节点下线
```
简单情况：直接从树中移除
处理：父节点更新子节点列表，容量 +1
```

#### 场景 2：中间节点下线
```
问题：子树失去连接

解决方案 A：子树提升（优先）
  Before:       After:
     P             P
     |            /|\
     X    =>    C1 C2 C3
    /|\
  C1 C2 C3

步骤：
1. 子节点检测父节点心跳超时
2. 子节点向祖父节点请求挂载
3. 祖父节点检查容量
4. 如果容量足够：直接挂载
5. 如果容量不足：触发局部重组

解决方案 B：子树重组（备选）
  Before:       After:
     P             P
     |             |
     X    =>      C1 (新子组长)
    /|\          / \
  C1 C2 C3     C2  C3

步骤：
1. 子节点选举新的局部根（质量最好的子节点）
2. 新根向祖父节点请求挂载
3. 其他子节点重新挂载到新根
```

#### 场景 3：根节点下线
```
问题：整棵树失去根

解决方案：快速重选举
1. 所有一级子节点检测到根下线
2. 触发全局根选举（基于质量评分）
3. 新根广播自己的身份
4. 所有节点重新计算到新根的路径
5. 逐步调整树结构（避免震荡）
```

### 4. 消息路由（参考 OSPF LSA）

#### Link State Advertisement
```typescript
interface LSA {
  nodeId: string
  sequence: number           // 序列号（单调递增）
  age: number               // 年龄（TTL）
  links: Array<{
    neighbor: string
    cost: number            // RTT
    capacity: number        // 剩余容量
  }>
  quality: NodeQuality
}

// 定期泛洪 LSA
function floodLSA() {
  const lsa: LSA = {
    nodeId: myId,
    sequence: ++lsaSequence,
    age: 0,
    links: Array.from(neighbors.entries()).map(([id, peer]) => ({
      neighbor: id,
      cost: peer.rtt,
      capacity: peer.capacity
    })),
    quality: myQuality
  }
  
  // 向所有邻居发送
  broadcast({ kind: 'lsa-update', lsa })
}

// 接收 LSA 并更新拓扑视图
function handleLSA(from: string, lsa: LSA) {
  const existing = lsaDatabase.get(lsa.nodeId)
  
  // 检查是否是更新的信息
  if (existing && existing.sequence >= lsa.sequence) {
    return  // 旧信息，丢弃
  }
  
  // 更新数据库
  lsaDatabase.set(lsa.nodeId, lsa)
  
  // 继续泛洪（除了来源）
  for (const neighbor of neighbors.keys()) {
    if (neighbor !== from) {
      sendTo(neighbor, { kind: 'lsa-update', lsa })
    }
  }
  
  // 重新计算路由表
  recalculateRoutingTable()
}
```

#### 路由表计算（Dijkstra）
```typescript
function recalculateRoutingTable() {
  // 使用 LSA 数据库构建全网拓扑图
  const graph = buildGraphFromLSA(lsaDatabase)
  
  // Dijkstra 最短路径算法
  const routingTable = new Map<string, {
    nextHop: string      // 下一跳节点
    distance: number     // 总代价
    path: string[]       // 完整路径
  }>()
  
  const distances = new Map<string, number>()
  const previous = new Map<string, string>()
  const queue = new PriorityQueue<{ node: string; dist: number }>()
  
  distances.set(myId, 0)
  queue.push({ node: myId, dist: 0 })
  
  while (queue.notEmpty()) {
    const { node, dist } = queue.pop()
    
    if (dist > (distances.get(node) ?? Infinity)) continue
    
    const lsa = lsaDatabase.get(node)
    if (!lsa) continue
    
    for (const link of lsa.links) {
      const newDist = dist + link.cost
      const oldDist = distances.get(link.neighbor) ?? Infinity
      
      if (newDist < oldDist) {
        distances.set(link.neighbor, newDist)
        previous.set(link.neighbor, node)
        queue.push({ node: link.neighbor, dist: newDist })
      }
    }
  }
  
  // 构建路由表
  for (const [dest, dist] of distances) {
    if (dest === myId) continue
    
    // 回溯路径找到第一跳
    const path: string[] = []
    let current = dest
    while (current !== myId) {
      path.unshift(current)
      current = previous.get(current)!
    }
    
    routingTable.set(dest, {
      nextHop: path[0],
      distance: dist,
      path
    })
  }
  
  return routingTable
}
```

### 5. 负载均衡与树优化

#### 动态调整
```typescript
// 定期检查树的平衡性
function rebalanceTree() {
  // 1. 检查节点负载
  for (const [nodeId, node] of treeNodes) {
    const loadRatio = node.children.size / node.maxDegree
    
    // 负载过高（>80%）：拒绝新连接，引导到兄弟节点
    if (loadRatio > 0.8) {
      node.capacity = 0
      notifyParent({ kind: 'overload', nodeId })
    }
    
    // 负载过低（<20%）且有兄弟过载：接收迁移
    if (loadRatio < 0.2) {
      offerCapacity(nodeId, node.capacity)
    }
  }
  
  // 2. 检查树深度
  const maxDepth = getMaxDepth(tree)
  const avgDepth = getAvgDepth(tree)
  
  // 树过深：触发重组
  if (maxDepth > Math.log2(treeNodes.size) * 2) {
    console.warn('Tree too deep, triggering rebuild')
    triggerTreeRebuild()
  }
}

// 子节点迁移
function migrateChild(
  child: string,
  oldParent: string,
  newParent: string
) {
  // 1. 通知子节点更换父节点
  sendTo(child, {
    kind: 'parent-change',
    oldParent,
    newParent
  })
  
  // 2. 更新树结构
  tree.getNode(oldParent).children.delete(child)
  tree.getNode(newParent).children.add(child)
  tree.getNode(child).parent = newParent
  
  // 3. 更新容量
  tree.getNode(oldParent).capacity++
  tree.getNode(newParent).capacity--
  
  // 4. 重新建立连接
  disconnectPeer(child, oldParent)
  connectPeer(child, newParent)
}
```

### 6. 容错机制

#### 心跳与故障检测
```typescript
interface Heartbeat {
  kind: 'heartbeat'
  nodeId: string
  role: 'root' | 'parent' | 'child'
  sequence: number
  timestamp: number
  quality: NodeQuality
}

// 向关键节点发送心跳
function sendHeartbeats() {
  const hb: Heartbeat = {
    kind: 'heartbeat',
    nodeId: myId,
    role: getMyRole(),
    sequence: ++heartbeatSeq,
    timestamp: Date.now(),
    quality: getMyQuality()
  }
  
  // 向父节点发送
  if (myParent) {
    sendTo(myParent, hb)
  }
  
  // 向所有子节点发送
  for (const child of myChildren) {
    sendTo(child, hb)
  }
}

// 检测故障
function detectFailures() {
  const now = Date.now()
  const timeout = 3 * HEARTBEAT_INTERVAL
  
  // 检查父节点
  if (myParent) {
    const lastHb = lastHeartbeat.get(myParent) ?? 0
    if (now - lastHb > timeout) {
      handleParentFailure()
    }
  }
  
  // 检查子节点
  for (const child of myChildren) {
    const lastHb = lastHeartbeat.get(child) ?? 0
    if (now - lastHb > timeout) {
      handleChildFailure(child)
    }
  }
}

// 父节点下线处理
async function handleParentFailure() {
  console.warn('Parent node failed, reconnecting...')
  
  // 策略 1：连接到祖父节点
  if (myGrandparent) {
    const success = await requestMount(myGrandparent)
    if (success) return
  }
  
  // 策略 2：连接到叔叔节点（父节点的兄弟）
  const uncles = findUncles()
  for (const uncle of uncles) {
    const success = await requestMount(uncle)
    if (success) return
  }
  
  // 策略 3：成为新的局部根
  becomeLocalRoot()
}

// 子节点下线处理
function handleChildFailure(child: string) {
  // 从子节点列表移除
  myChildren.delete(child)
  myCapacity++
  
  // 断开连接
  disconnectPeer(child)
  
  // 通知其他节点
  broadcastLSA()
}
```

## 协议消息定义

```typescript
// 树构建消息
type TreeMessage =
  // 请求挂载
  | { kind: 'mount-request'; nodeId: string; quality: NodeQuality }
  | { kind: 'mount-accept'; parent: string }
  | { kind: 'mount-reject'; reason: string }
  
  // 父节点变更
  | { kind: 'parent-change'; oldParent: string; newParent: string }
  
  // 根选举
  | { kind: 'root-election'; candidate: string; quality: NodeQuality; term: number }
  | { kind: 'root-announce'; root: string; term: number }
  
  // LSA 泛洪
  | { kind: 'lsa-update'; lsa: LSA }
  
  // 负载信息
  | { kind: 'capacity-offer'; nodeId: string; capacity: number }
  | { kind: 'overload-notify'; nodeId: string }
  
  // 心跳
  | { kind: 'heartbeat'; nodeId: string; role: string; sequence: number; quality: NodeQuality }
```

## 性能分析

### 连接数对比

| 节点数 | 全连接 | 分层(组内全连) | 树状(度数=5) | 树状(度数=10) |
|--------|--------|----------------|--------------|---------------|
| 100    | 4,950  | ~495           | **99**       | **99**        |
| 500    | 124,750| ~2,475         | **499**      | **499**       |
| 1000   | 499,500| ~4,950         | **999**      | **999**       |

**结论：树状结构最优，连接数 = n-1**

### 单节点连接数

| 拓扑     | 最大连接数 | 平均连接数 |
|----------|-----------|-----------|
| 全连接   | n-1       | n-1       |
| 分层     | n-1 (组长)| ~√n       |
| 树状(5)  | **5**     | **~3**    |
| 树状(10) | **10**    | **~5**    |

**结论：树状结构单节点负载可控**

### 延迟分析

| 拓扑     | 平均跳数    | 最大跳数      |
|----------|-----------|--------------|
| 全连接   | 1         | 1            |
| 分层     | ~1.5      | 2            |
| 树状(5)  | ~log₅(n)  | 2*log₅(n)    |
| 树状(10) | ~log₁₀(n) | 2*log₁₀(n)   |

**示例（100节点）：**
- 树状(度数5)：平均 ~3 跳，最大 ~6 跳
- 树状(度数10)：平均 ~2 跳，最大 ~4 跳

## 配置参数

```typescript
interface TreeConfig {
  maxDegree: number           // 最大连接数（默认 8）
  minDegree: number          // 最小连接数（默认 2）
  heartbeatInterval: number  // 心跳间隔（默认 2000ms）
  failureTimeout: number     // 故障超时（默认 6000ms）
  lsaInterval: number        // LSA 更新间隔（默认 10000ms）
  rebalanceInterval: number  // 重平衡间隔（默认 30000ms）
  maxDepthRatio: number      // 最大深度比例（默认 2.0）
}
```

## 实现优先级

### Phase 1: 基础树构建（高优先级）
- [ ] TreeNode 数据结构
- [ ] 基于度数限制的树构建算法
- [ ] 父子节点连接管理
- [ ] 基础消息路由（沿树转发）

### Phase 2: 故障恢复（高优先级）
- [ ] 心跳机制
- [ ] 父节点故障检测和恢复
- [ ] 子节点故障处理
- [ ] 根节点重选举

### Phase 3: LSA 与路由（中优先级）
- [ ] LSA 生成和泛洪
- [ ] 路由表计算（Dijkstra）
- [ ] 基于路由表的消息转发

### Phase 4: 优化与负载均衡（中优先级）
- [ ] 节点质量评分
- [ ] 动态树重平衡
- [ ] 子节点迁移
- [ ] 树深度优化

### Phase 5: 高级特性（低优先级）
- [ ] 多根容错（根节点冗余）
- [ ] 路径冗余（环路检测）
- [ ] QoS 路由（基于带宽优先级）
- [ ] 拥塞控制

## 参考资料

- OSPF (Open Shortest Path First) RFC 2328
- RIP (Routing Information Protocol) RFC 2453
- Spanning Tree Protocol (STP) IEEE 802.1D
- Prim's Minimum Spanning Tree Algorithm
- Dijkstra's Shortest Path Algorithm
