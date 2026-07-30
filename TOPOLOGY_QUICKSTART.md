# 网络拓扑优化 - 快速开始

## 🎉 功能已实现！

pphub 现在支持分层网络拓扑，可以将连接数从 O(n²) 优化到 O(n)，支持更大规模的网络。

## 快速启用

### 方法 1：在代码中启用（推荐）

在你的房间初始化代码中：

```typescript
import { Mesh } from '@/core/mesh'

// 创建 Mesh 时指定模式
const mesh = new Mesh(signaling, 'hierarchical')

// 或者动态切换
mesh.setTopologyMode('hierarchical')
```

### 方法 2：通过 localStorage

在浏览器控制台执行：

```javascript
// 启用分层模式
localStorage.setItem('pphub:topology:mode', 'hierarchical')

// 切换回全连接模式
localStorage.setItem('pphub:topology:mode', 'full-mesh')

// 刷新页面生效
location.reload()
```

### 方法 3：添加 UI 控制

在设置面板中使用 TopologySettings 组件：

```vue
<script setup lang="ts">
import { ref } from 'vue'
import TopologySettings from '@/components/TopologySettings.vue'
import { useRoom } from '@/stores/room'

const room = useRoom()
const mode = ref(room.mesh.getTopologyMode())
const stats = ref(room.mesh.getTopologyStats())
const groups = ref(room.mesh.topology.getGroupsList())

// 监听更新
room.mesh.on('topology-mode', (m) => mode.value = m)
room.mesh.on('topology-groups', (g) => {
  groups.value = g
  stats.value = room.mesh.getTopologyStats()
})

const handleModeChange = (newMode) => {
  room.mesh.setTopologyMode(newMode)
}
</script>

<template>
  <TopologySettings
    :mode="mode"
    :stats="stats"
    :groups="groups"
    @update:mode="handleModeChange"
  />
</template>
```

## 效果对比

### 示例：30 人房间

**全连接模式：**
- 连接数：435 条
- 每个节点：29 个连接
- 带宽消耗：高

**分层模式：**
- 连接数：~135 条
- 每个节点：4-10 个连接
- 带宽消耗：低 69%
- 额外延迟：10-50ms（跨组）

### 示例：100 人房间

**全连接模式：**
- 连接数：4,950 条
- 每个节点：99 个连接
- 带宽消耗：极高（不可行）

**分层模式：**
- 连接数：~495 条
- 每个节点：9-19 个连接
- 带宽消耗：低 90%
- 额外延迟：10-50ms（跨组）

## 查看状态

### 在控制台查看

```javascript
// 获取统计信息
const stats = mesh.getTopologyStats()
console.log('当前模式:', stats.mode)
console.log('总节点数:', stats.totalPeers)
console.log('网络分组:', stats.totalGroups)
console.log('我的组大小:', stats.myGroupSize)
console.log('我是组长:', stats.isLeader)
console.log('当前连接数:', stats.requiredConnections)

// 查看分组详情
const groups = mesh.topology.getGroupsList()
groups.forEach((group, i) => {
  console.log(`组 ${i+1}:`, {
    组长: group.leader.slice(0, 8),
    成员数: group.members.size,
    平均RTT: group.avgRtt.toFixed(0) + 'ms'
  })
})
```

### 启用调试日志

```javascript
// 查看拓扑变化
localStorage.setItem('pphub:debug:topology', 'true')

// 查看 ICE 连接详情
localStorage.setItem('pphub:debug:ice', 'true')
```

## 推荐配置

### 根据场景选择

```typescript
function getRecommendedMode(context: {
  peerCount: number
  latencySensitive: boolean
  bandwidthLimited: boolean
}): 'full-mesh' | 'hierarchical' {
  
  // 延迟敏感（游戏、视频通话）
  if (context.latencySensitive && context.peerCount < 20) {
    return 'full-mesh'
  }
  
  // 带宽受限
  if (context.bandwidthLimited) {
    return 'hierarchical'
  }
  
  // 大规模网络
  if (context.peerCount > 10) {
    return 'hierarchical'
  }
  
  // 默认全连接
  return 'full-mesh'
}

// 使用
const mode = getRecommendedMode({
  peerCount: peers.length,
  latencySensitive: isGaming,
  bandwidthLimited: isMobile
})
mesh.setTopologyMode(mode)
```

### 自动切换

```typescript
// 根据人数自动切换
mesh.on('peer-added', () => {
  const stats = mesh.getTopologyStats()
  const suggested = stats.totalPeers > 10 ? 'hierarchical' : 'full-mesh'
  
  if (suggested !== mesh.getTopologyMode()) {
    console.log(`建议切换到 ${suggested} 模式`)
    mesh.setTopologyMode(suggested)
  }
})
```

## 监控和调试

### 实时监控面板

```vue
<template>
  <div class="topology-monitor">
    <div class="stat">
      <span>模式:</span>
      <strong>{{ stats.mode }}</strong>
    </div>
    <div class="stat">
      <span>连接数:</span>
      <strong>{{ stats.requiredConnections }}</strong>
      <small v-if="stats.mode === 'hierarchical'">
        (全连接需要 {{ fullMeshConnections }})
      </small>
    </div>
    <div class="stat" v-if="stats.mode === 'hierarchical'">
      <span>分组:</span>
      <strong>{{ stats.totalGroups }}</strong>
    </div>
    <div class="stat" v-if="stats.isLeader">
      <span>角色:</span>
      <strong>🌟 组长</strong>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ stats: any }>()

const fullMeshConnections = computed(() => {
  const n = props.stats.totalPeers
  return n > 0 ? (n * (n - 1)) / 2 : 0
})
</script>
```

### 性能指标

```typescript
// 测量路由延迟
async function measureRoutingLatency(targetPeer: string) {
  const start = performance.now()
  
  await new Promise<void>((resolve) => {
    const seq = Date.now()
    mesh.sendTo(targetPeer, { kind: 'ping', seq })
    
    const off = mesh.on('control', (msg) => {
      if (msg.kind === 'pong' && msg.seq === seq) {
        off()
        resolve()
      }
    })
  })
  
  const elapsed = performance.now() - start
  const inSameGroup = mesh.topology.inSameGroup(mesh.myId, targetPeer)
  
  console.log(`延迟到 ${targetPeer.slice(0, 8)}:`, {
    时间: elapsed.toFixed(1) + 'ms',
    同组: inSameGroup,
    路径: inSameGroup ? '直连' : '中继'
  })
}
```

## 故障排查

### 问题：分组不生效

**检查：**
```javascript
console.log('当前模式:', mesh.getTopologyMode())
console.log('总节点数:', mesh.getTopologyStats().totalPeers)
```

**原因：**
- 模式未正确设置
- 节点数太少（< 2）

**解决：**
```javascript
mesh.setTopologyMode('hierarchical')
```

### 问题：消息延迟高

**检查：**
```javascript
const inSameGroup = mesh.topology.inSameGroup(myId, targetPeer)
console.log('同组:', inSameGroup)
```

**原因：**
- 跨组通信需要中继（额外 1 跳）
- 组长节点网络质量差

**解决：**
- 切换到全连接模式（延迟优先）
- 等待拓扑重评估（60秒）

### 问题：连接数未减少

**检查：**
```javascript
const stats = mesh.getTopologyStats()
console.log('当前连接:', stats.requiredConnections)
console.log('应该需要:', Math.ceil(stats.totalPeers / 2))
```

**原因：**
- 所有节点RTT都很低（被分到同一组）
- 拓扑尚未重评估

**解决：**
- 等待拓扑重评估
- 调整分组阈值

## 下一步

- 📖 阅读完整文档：[TOPOLOGY_GUIDE.md](./TOPOLOGY_GUIDE.md)
- 🎨 查看设计文档：[TOPOLOGY_DESIGN.md](./TOPOLOGY_DESIGN.md)
- 📊 查看实现总结：[TOPOLOGY_IMPLEMENTATION.md](./TOPOLOGY_IMPLEMENTATION.md)

## 反馈

如有问题或建议，欢迎提 Issue！
