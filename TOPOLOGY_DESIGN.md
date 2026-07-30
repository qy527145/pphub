# 网络拓扑优化设计文档

## 问题背景

当前 pphub 使用全连接网络（Full Mesh）拓扑：
- n 个节点会产生 n(n-1)/2 条 WebRTC 连接
- 网络规模增长时，连接数呈平方级增长
- 每个节点需要维护大量连接，消耗带宽和计算资源

## 优化目标

实现分层分组网络拓扑：
- 连接数从 O(n²) 降至 O(n)
- 同一局域网内的节点直接 P2P 连接
- 不同局域网通过组长（Leader）节点中继
- 服务端只需中继组长之间的流量
- 支持组长选举和故障转移

## 架构设计

### 1. 网络分组（Network Partitioning）

**分组策略**：
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

**分组判断依据**：
1. RTT 延迟（<20ms 可能在同一局域网）
2. ICE 候选类型（host 类型且能直连）
3. IP 地址前缀相似度
4. 连接质量评分

### 2. 组长选举（Leader Election）

**选举规则**（按优先级）：
1. **确定性选举**：peerId 字典序最小的节点
   - 优点：全网一致，无需协商
   - 缺点：可能选中性能较弱的节点

2. **能力选举**（备选方案）：
   - 在线时长最长
   - 连接质量最好（平均 RTT 最低）
   - 带宽最充足

**组长职责**：
- 维护组内成员列表
- 与其他组的组长建立连接
- 中转跨组消息
- 定期广播心跳

**故障转移**：
- 组长下线后，组员自动重新选举
- 新组长立即通知其他组
- 过渡期可能短暂出现消息丢失（可容忍）

### 3. 拓扑维护

**节点加入流程**：
```
1. 新节点加入房间
2. 与所有现有节点建立临时连接（探测期）
3. 测量 RTT 和连接质量（5-10秒）
4. 根据网络距离分配到最近的组
5. 与同组节点保持全连接
6. 与其他组只通过组长通信
7. 断开非必要的直连
```

**拓扑调整触发条件**：
- 新节点加入/离开
- 组长下线
- 连接质量显著变化（如网络切换）
- 定期重评估（每 60 秒）

### 4. 消息路由

**路由策略**：
```typescript
function routeMessage(from: string, to: string, msg: Message) {
  const fromGroup = getGroup(from)
  const toGroup = getGroup(to)
  
  if (fromGroup === toGroup) {
    // 同组：直接发送
    sendDirect(to, msg)
  } else {
    // 跨组：通过组长中继
    const myLeader = getLeader(fromGroup)
    const targetLeader = getLeader(toGroup)
    
    if (myId === myLeader) {
      // 我是组长：直接发给对方组长
      sendDirect(targetLeader, { relay: true, to, msg })
    } else {
      // 我是组员：发给我的组长
      sendDirect(myLeader, { relay: true, to, msg })
    }
  }
}
```

**广播优化**：
- 同组内：所有节点直接广播
- 跨组：只向组长发送一次，由对方组长转发给组员

### 5. 数据结构

```typescript
// 网络拓扑管理器
class TopologyManager {
  // 当前拓扑模式
  mode: 'full-mesh' | 'hierarchical'
  
  // 分组信息
  groups: Map<string, NetworkGroup>  // groupId -> group
  peerGroups: Map<string, string>    // peerId -> groupId
  
  // 路由表
  routes: Map<string, string>        // targetPeer -> nextHop
  
  // 网络质量数据
  rtts: Map<string, number>          // peerId -> rtt
  connectionQuality: Map<string, QualityMetrics>
}

// 网络组
interface NetworkGroup {
  id: string
  leader: string          // 当前组长
  members: Set<string>    // 所有成员
  candidates: string[]    // 备选组长（按优先级排序）
  avgRtt: number         // 组内平均延迟
  lastElection: number   // 上次选举时间
}

// 连接质量指标
interface QualityMetrics {
  rtt: number            // 往返延迟
  packetLoss: number     // 丢包率
  jitter: number         // 抖动
  bandwidth: number      // 可用带宽估计
  iceType: 'host' | 'srflx' | 'relay'  // ICE 候选类型
}
```

## 实现计划

### Phase 1: 基础设施（1-2天）
- [ ] 创建 `topology.ts` 模块
- [ ] 实现网络质量监测
- [ ] 实现分组算法（基于 RTT 聚类）
- [ ] 实现组长选举逻辑

### Phase 2: 路由层（2-3天）
- [ ] 扩展 `mesh.ts`，支持路由表
- [ ] 实现消息路由逻辑
- [ ] 添加中继消息类型到 `messages.ts`
- [ ] 处理跨组消息转发

### Phase 3: 连接管理（2-3天）
- [ ] 修改 `mesh.ts` 连接建立逻辑
- [ ] 实现按需连接（同组全连接，跨组通过组长）
- [ ] 优化连接生命周期管理
- [ ] 添加拓扑切换逻辑

### Phase 4: 故障处理（1-2天）
- [ ] 组长故障检测和快速重选
- [ ] 网络分区检测和恢复
- [ ] 消息重传和去重
- [ ] 拓扑变更时的平滑过渡

### Phase 5: 优化和测试（2-3天）
- [ ] 性能优化（减少冗余消息）
- [ ] 添加拓扑可视化（UI）
- [ ] 编写单元测试
- [ ] 压力测试（100+ 节点）

## 兼容性策略

**渐进式部署**：
1. 默认保持 full-mesh 模式（兼容现有代码）
2. 添加配置开关 `ENABLE_HIERARCHICAL_TOPOLOGY`
3. 新旧版本可以在同一房间共存：
   - 新版本节点之间使用分层拓扑
   - 与旧版本节点保持全连接
4. 逐步迁移，最终移除 full-mesh

**协议扩展**：
```typescript
// 添加新的控制消息
interface TopologyMessage {
  // 拓扑信息交换
  kind: 'topo-announce'   // 通告自己的组信息
  groupId: string
  leader: string
  members: string[]
  
  // 组长选举
  kind: 'leader-elect'    // 发起选举
  kind: 'leader-ack'      // 确认新组长
  
  // 消息中继
  kind: 'relay-forward'   // 转发消息
  originalFrom: string
  finalTo: string
  payload: ControlMessage
}
```

## 性能预期

### 连接数优化
- 原方案：100 节点 = 4,950 条连接
- 新方案：100 节点（10组，每组10人）= 450 组内连接 + 45 组间连接 = 495 条
- **减少 90% 连接数**

### 延迟影响
- 同组通信：无额外延迟（直连）
- 跨组通信：+1 跳（组长中继），增加约 10-50ms
- 可接受范围（文件传输、聊天、屏幕共享）

### 带宽节省
- 广播消息：从 O(n) 降至 O(√n)（假设均匀分组）
- 组长节点带宽需求增加，但整体带宽消耗下降

## 安全考虑

1. **组长信任**：组长可以看到路由的消息元数据
   - 缓解：保持端到端加密（组长只转发密文）
   - 用户可以选择"仅直连"模式，拒绝中继

2. **恶意组长**：故意丢弃或篡改消息
   - 检测：超时 + 重传机制
   - 惩罚：踢出组长，重新选举
   - 验证：消息签名（可选）

3. **Sybil 攻击**：伪造多个身份控制组长选举
   - 缓解：房间准入控制（短码）
   - 可选：Proof-of-Work 或邀请制

## 未来扩展

1. **智能路由**：基于带宽和延迟动态选择路径
2. **多跳中继**：当两组无法直连时，通过第三组中转
3. **分层扩展**：超大网络支持二级、三级分组
4. **负载均衡**：多个组长分担跨组流量

## 参考资料

- WebRTC Mesh vs SFU vs MCU
- Raft Consensus Algorithm
- Kademlia DHT (分布式路由)
- BATMAN Mesh Routing Protocol
