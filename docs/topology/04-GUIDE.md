# 网络拓扑优化使用指南

## 概述

pphub 现在支持两种网络拓扑模式：

1. **全连接模式 (Full Mesh)** - 原有的模式，适合小规模网络
2. **分层拓扑模式 (Hierarchical)** - 新增的优化模式，适合大规模网络

## 核心改进

### 问题
- 原全连接网络：n 个节点产生 **n(n-1)/2** 条连接
- 100 个节点需要 **4,950** 条连接
- 每个节点维护大量连接，消耗大量带宽和资源

### 解决方案
- 分层拓扑：根据网络延迟自动分组
- 同组内全连接（低延迟）
- 跨组通过组长中继
- 100 个节点（10组）只需约 **495** 条连接
- **减少 90% 的连接数**

## 工作原理

### 网络分组
```
局域网A (4个节点)          局域网B (2个节点)
    ┌─────┐                    ┌─────┐
    │ A1* │◄──────────────────►│ B1* │  组长之间中继
    └─────┘                    └─────┘
      │ │ │                      │
      │ │ └────────┐             │
      │ └────┐     │             │
    ┌─┴──┐ ┌─┴──┐ ┌┴───┐      ┌─┴──┐
    │ A2 │ │ A3 │ │ A4 │      │ B2 │
    └────┘ └────┘ └────┘      └────┘
    组内全连接               组内直连
```

### 分组策略
- **RTT 延迟** < 30ms：认为在同一局域网
- **ICE 类型**：host 类型优先分组
- **连接质量**：综合评分

### 组长选举
- **确定性**：peerId 字典序最小的节点自动成为组长
- **无需协商**：全网一致
- **自动切换**：组长下线后立即重新选举

### 消息路由
- **同组消息**：直接发送（0 跳）
- **跨组消息**：通过组长中继（1-2 跳）
- **广播优化**：组长负责分发，避免重复发送

## 使用方法

### 1. 在代码中启用

```typescript
import { Mesh } from './core/mesh'
import type { TopologyMode } from './core/topology'

// 创建 Mesh 时指定模式
const mesh = new Mesh(signaling, 'hierarchical')

// 或者动态切换
mesh.setTopologyMode('hierarchical')

// 获取当前模式
const mode = mesh.getTopologyMode()

// 获取统计信息
const stats = mesh.getTopologyStats()
console.log('当前连接数:', stats.requiredConnections)
console.log('全连接需要:', stats.totalPeers * (stats.totalPeers - 1) / 2)
console.log('我是组长:', stats.isLeader)
```

### 2. 在 UI 中使用

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import TopologySettings from './components/TopologySettings.vue'

const room = useRoom() // 你的房间 store

const topologyMode = ref(room.mesh.getTopologyMode())
const topologyStats = ref(room.mesh.getTopologyStats())
const topologyGroups = ref(room.mesh.topology.getGroupsList())

// 监听拓扑更新
room.mesh.on('topology-mode', (mode) => {
  topologyMode.value = mode
})

room.mesh.on('topology-groups', (groups) => {
  topologyGroups.value = groups
  topologyStats.value = room.mesh.getTopologyStats()
})

const handleModeChange = (newMode) => {
  room.mesh.setTopologyMode(newMode)
}
</script>

<template>
  <TopologySettings
    :mode="topologyMode"
    :stats="topologyStats"
    :groups="topologyGroups"
    @update:mode="handleModeChange"
  />
</template>
```

### 3. 持久化配置

拓扑模式会自动保存到 localStorage：

```javascript
// 读取
const savedMode = localStorage.getItem('pphub:topology:mode')

// 设置
localStorage.setItem('pphub:topology:mode', 'hierarchical')
```

## 配置选项

可以自定义分组阈值：

```typescript
import { TopologyManager } from './core/topology'

const topology = new TopologyManager({
  maxRttForSameGroup: 30,      // 同组最大 RTT (ms)
  minGroupSize: 2,             // 最小组大小
  maxGroupSize: 20,            // 最大组大小
  reevaluateInterval: 60_000,  // 重评估间隔 (ms)
  leaderTimeout: 15_000,       // 组长心跳超时 (ms)
})
```

## 性能对比

### 小规模网络 (10 人)
- **全连接**: 45 条连接
- **分层模式**: ~45 条连接
- **结论**: 差异不大，建议用全连接（延迟更低）

### 中等规模 (30 人)
- **全连接**: 435 条连接
- **分层模式**: ~135 条连接（3组，每组10人）
- **优化**: 减少 69%

### 大规模 (100 人)
- **全连接**: 4,950 条连接
- **分层模式**: ~495 条连接（10组，每组10人）
- **优化**: 减少 90%

### 超大规模 (500 人)
- **全连接**: 124,750 条连接（不可行）
- **分层模式**: ~2,475 条连接（50组，每组10人）
- **优化**: 减少 98%

## 延迟影响

- **同组通信**: 0 额外延迟（直连）
- **跨组通信**: +1 跳，约增加 10-50ms
- **对延迟敏感的应用**（实时游戏）：建议用全连接
- **对延迟不敏感的应用**（文件传输、聊天）：推荐分层模式

## 最佳实践

### 何时使用全连接模式
- 房间人数 < 10 人
- 对延迟要求极高（实时游戏、视频通话）
- 所有人在同一局域网

### 何时使用分层模式
- 房间人数 > 10 人
- 跨多个局域网/地区
- 对带宽和资源有限制
- 文件共享、协作工具、大型会议

### 自动切换建议

```typescript
// 根据人数自动选择模式
function autoSelectMode(peerCount: number): TopologyMode {
  return peerCount > 10 ? 'hierarchical' : 'full-mesh'
}

mesh.on('peer-added', () => {
  const stats = mesh.getTopologyStats()
  const suggestedMode = autoSelectMode(stats.totalPeers)
  if (suggestedMode !== mesh.getTopologyMode()) {
    console.log(`建议切换到 ${suggestedMode} 模式`)
    // 可选：自动切换
    // mesh.setTopologyMode(suggestedMode)
  }
})
```

## 故障处理

### 组长下线
- 自动重新选举新组长
- 选举时间 < 1 秒
- 短暂消息丢失（可容忍）

### 网络分区
- 自动检测并重组
- 每 60 秒重评估拓扑
- RTT 显著变化时触发重组

### 连接质量下降
- 动态调整分组
- 可能重新选举组长
- 平滑过渡，无需手动干预

## 监控和调试

### 查看分组信息

```typescript
const groups = mesh.topology.getGroupsList()
groups.forEach((group, index) => {
  console.log(`组 ${index + 1}:`)
  console.log(`  组长: ${group.leader}`)
  console.log(`  成员: ${Array.from(group.members).join(', ')}`)
  console.log(`  平均RTT: ${group.avgRtt}ms`)
})
```

### 查看路由路径

```typescript
// 检查是否在同一组
const inSameGroup = mesh.topology.inSameGroup(peer1Id, peer2Id)

// 获取组长
const myLeader = mesh.topology.getMyLeader()
const peerLeader = mesh.topology.getLeader(peerId)
```

### 启用调试日志

在控制台查看拓扑变化：

```javascript
localStorage.setItem('pphub:debug:topology', 'true')
```

## 安全考虑

### 组长信任
- **问题**: 组长可以看到路由的消息元数据
- **缓解**: 消息内容保持端到端加密，组长只转发密文
- **选择**: 用户可以拒绝中继，只与同组节点通信

### 恶意组长
- **检测**: 超时 + 重传机制
- **惩罚**: 自动重新选举
- **验证**: 消息签名（可选）

## 未来扩展

- [ ] 智能路由：基于带宽和延迟动态选择路径
- [ ] 多跳中继：通过第三组中转
- [ ] 二级分组：超大网络的分层扩展
- [ ] 负载均衡：多个组长分担流量
- [ ] 组长能力评估：选择性能最好的节点

## 技术参考

- WebRTC Mesh vs SFU vs MCU
- Raft Consensus Algorithm
- Kademlia DHT (分布式路由)
- BATMAN Mesh Routing Protocol

## 支持

如有问题或建议，请访问项目 Issues 页面。
