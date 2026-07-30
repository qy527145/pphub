# 网络拓扑优化文档

## 🎯 核心价值

pphub 的网络拓扑优化让你可以：
- 支持从 **10 人到 1000+ 人**的各种规模网络
- **保持 100% P2P 连接**（无服务器中继）
- **自动优化路由**（10秒探测期）
- **客户端均摊负载**（局域网内自发中继）

## 📖 文档导航

### 快速上手（5分钟）
**→ [02-QUICKSTART.md](./02-QUICKSTART.md)**
- 如何启用拓扑优化
- 基本验证方法
- 常见问题

### 深入理解（15分钟）
**→ [03-COMPARISON.md](./03-COMPARISON.md)**
- 三种拓扑模式对比
- 性能分析
- 场景推荐

### 完整指南（30分钟）
**→ [04-GUIDE.md](./04-GUIDE.md)**
- 完整使用文档
- API 参考
- 最佳实践
- 故障排查

### 技术原理（深度）
**→ [05-DESIGN.md](./05-DESIGN.md)** - 分层拓扑设计  
**→ [06-TREE-DESIGN.md](./06-TREE-DESIGN.md)** - 树状拓扑设计

### 最新修复
**→ [01-P2P-FIX.md](./01-P2P-FIX.md)** ⭐
- 解决服务器中继问题
- 保持 P2P 连接
- 修复时间：2026-07-30

---

## 🚀 三种拓扑模式

### 1. 全连接 (Full Mesh)
```
适用: <10 人
特点: 所有节点两两直连
优势: 延迟最低
劣势: 连接数多 O(n²)
```

### 2. 分层 (Hierarchical) ⭐ 推荐
```
适用: 10-100 人
特点: 按 RTT 自动分组，组内全连接，跨组组长中继
优势: 平衡延迟和连接数
效果: -70% to -90% 连接数
```

### 3. 树状 (Tree)
```
适用: 100-1000+ 人
特点: 树状结构，每节点最多 maxDegree 个连接
优势: 单节点负载可控
效果: -98% 连接数
```

---

## 📊 性能对比

### 100 节点网络

| 模式 | 连接数 | 单节点最大连接 | 优化 |
|------|--------|----------------|------|
| 全连接 | 4,950 | 99 | - |
| 分层 | ~495 | ~19 | **-90%** |
| 树状 | 99 | ≤8 | **-98%** |

### 实际场景

**小型会议（8人）**
```
全连接: 28 条 P2P
分层:   28 条 P2P（保持全部，优化路由）
效果:   延迟最低，通信正常 ✅
```

**中型协作（50人）**
```
全连接: 1,225 条（不可行）
分层:   ~150 条
效果:   -88% 连接数 ✅
```

**大型活动（100人）**
```
全连接: 4,950 条（不可行）
分层:   ~495 条
树状:   99 条
效果:   分层 -90%，树状 -98% ✅
```

---

## ⚙️ 工作原理

### 自动优化流程

```
0秒    - 加入房间
       ↓
0-10秒 - 探测期：建立全连接，收集 RTT 数据
       ↓
10秒   - 自动触发拓扑优化
       ├─ 分层模式：按 RTT 聚类分组
       ├─ 树状模式：构建最小生成树
       └─ 优化路由策略
       ↓
10秒+  - 优化完成
       ├─ 所有 P2P 连接保持 ✅
       ├─ 优先使用必要连接
       └─ 其他连接作为备用
```

### 核心设计

**关键原则：**
1. **保持所有 P2P 连接** - 不关闭 WebRTC
2. **优化路由策略** - 智能选择转发路径
3. **备用冗余** - 主路径故障自动切换
4. **客户端均摊** - 无服务器中继负载

---

## 🎓 关键概念

### RTT (Round-Trip Time)
往返时间，衡量节点间延迟的指标。同一局域网通常 <30ms。

### 分组 (Grouping)
根据 RTT 将节点聚类，同组内保持全连接，跨组通过组长中继。

### 组长 (Leader)
每组选举一个组长（字典序最小），负责跨组消息转发。

### 路由优化
不关闭连接，而是优先使用拓扑计算出的路径，其他连接作为备用。

---

## 🛠️ 配置

### 默认配置
```typescript
// 默认启用分层模式
topologyMode: 'hierarchical'

// 自动优化
autoOptimize: true
optimizeDelay: 10000  // 10秒

// 分组阈值
maxRttForSameGroup: 30  // 30ms
```

### 自定义配置
```typescript
// 环境变量
PPHUB_MAX_PEERS=500  // 最大节点数

// localStorage
localStorage.setItem('pphub:topology:mode', 'hierarchical')
```

---

## 🐛 故障排查

### 问题：仍然是全连接

**检查：**
```javascript
console.log(room.mesh.topology.getMode())
// 应该是 'hierarchical'
```

**解决：**
```javascript
room.mesh.setTopologyMode('hierarchical')
room.mesh.triggerTopologyOptimization()
```

### 问题：看到服务器中继

**检查：**
```javascript
for (const [id, peer] of room.mesh.peers) {
  console.log(id, peer.transport)
}
// 应该全部是 'webrtc'，不是 'relay'
```

**说明：** 如果看到 `relay`，说明 WebRTC 被关闭了，这是 bug。
请查看 [01-P2P-FIX.md](./01-P2P-FIX.md)。

---

## 📈 监控

### 实时统计
```javascript
// 查看统计
const stats = room.mesh.getTopologyStats()
console.log({
  模式: stats.mode,
  节点数: stats.totalPeers,
  分组数: stats.totalGroups,
  我是组长: stats.isLeader
})

// 查看连接数
console.log('P2P 连接:', room.mesh.peers.size)

// 查看分组
const groups = room.mesh.topology.getGroupsList()
groups.forEach((g, i) => {
  console.log(`组${i+1}: ${g.members.size}人`)
})
```

---

## 🎯 最佳实践

### 1. 根据人数选择模式
```
<10 人    → full-mesh
10-100 人 → hierarchical ⭐
100+ 人   → tree
```

### 2. 给予充足探测时间
默认 10 秒探测期是为了收集准确的 RTT 数据，不建议缩短。

### 3. 监控 P2P 状态
定期检查确保没有降级到服务器中继。

### 4. 使用可视化
启用 `TopologyGraph.vue` 组件查看网络拓扑。

---

## 🔗 相关链接

- [主项目 README](../../README.md)
- [文档中心](../README.md)
- [游戏大厅文档](../game-lobby/)
- [架构文档](../ARCHITECTURE.md)

---

## 📝 更新日志

### 2026-07-30 - v2.0
- ✅ 修复 P2P 降级问题
- ✅ 保持所有 WebRTC 连接
- ✅ 优化路由策略
- ✅ 文档整理

### 历史版本
详见 [archive/](./archive/) 目录。

---

**快速开始 → [02-QUICKSTART.md](./02-QUICKSTART.md)** 🚀
