# 网络拓扑优化 - 部署和可视化指南

## 🎉 问题已解决

### 1. ✅ 房间人数限制已提高

**修改内容：**
- 文件：`src/config.rs`
- 原值：`max_peers = 6`（全连接模式限制）
- 新值：`max_peers = 100`（支持分层和树状拓扑）

**生效方式：**
```bash
# 重新编译后端
cargo build --release

# 或通过环境变量覆盖（无需重新编译）
export PPHUB_MAX_PEERS=500
./pphub
```

**推荐配置：**
- 全连接模式：10 人以下
- 分层模式：100 人
- 树状模式：500+ 人

---

### 2. ✅ 新增拓扑可视化组件

**新组件：`web/src/components/TopologyGraph.vue`**

功能特性：
- 🎨 根据拓扑模式自动切换布局
- 📊 实时显示节点和连接统计
- 🎯 高亮显示特殊角色（根节点、组长、自己）
- 📈 显示连接优化效果
- 🌈 支持深色模式

---

## 📊 三种可视化布局

### 1. 全连接模式（Full Mesh）
```
布局：圆形
特点：
- 所有节点均匀分布在圆周上
- 所有节点两两连接
- 线条颜色：蓝色（直连）
```

### 2. 分层模式（Hierarchical）
```
布局：分组列式
特点：
- 按组垂直排列
- 组内节点全连接（蓝色线）
- 组长之间中继连接（黄色线）
- 组长节点用橙色标识
```

### 3. 树状模式（Tree）
```
布局：层级树状
特点：
- 根节点在顶部
- 按层级垂直展开
- 父子节点用绿色线连接
- 根节点用橙色标识
```

---

## 💻 使用方法

### 基础集成

```vue
<script setup lang="ts">
import { ref } from 'vue'
import TopologyGraph from '@/components/TopologyGraph.vue'
import { useRoom } from '@/stores/room'

const room = useRoom()

// 准备数据
const mode = ref<'full-mesh' | 'hierarchical' | 'tree'>('hierarchical')
const myId = room.myId
const peers = room.peers.map(p => ({
  peerId: p.id,
  nick: p.nick,
  rtt: p.rtt,
  state: p.connectionState
}))

// 分层模式数据
const groups = room.mesh.topology?.getGroupsList()

// 树状模式数据
const treeInfo = {
  root: room.mesh.treeTopology?.getRoot(),
  parent: room.mesh.treeTopology?.getParent(),
  children: room.mesh.treeTopology?.getChildren() || new Set(),
  level: room.mesh.treeTopology?.getLevel() || 0
}
</script>

<template>
  <div class="topology-container">
    <TopologyGraph
      :mode="mode"
      :myId="myId"
      :peers="peers"
      :groups="groups"
      :treeInfo="treeInfo"
    />
  </div>
</template>

<style scoped>
.topology-container {
  width: 100%;
  height: 600px;
}
</style>
```

### 与设置面板集成

```vue
<template>
  <div class="network-view">
    <!-- 拓扑设置 -->
    <TopologySettings
      :mode="topologyMode"
      :stats="topologyStats"
      :groups="topologyGroups"
      @update:mode="handleModeChange"
    />

    <!-- 拓扑可视化 -->
    <div class="graph-container">
      <h3>网络拓扑图</h3>
      <TopologyGraph
        :mode="topologyMode"
        :myId="myId"
        :peers="peers"
        :groups="topologyGroups"
        :treeInfo="treeInfo"
      />
    </div>

    <!-- 统计信息 -->
    <div class="stats-panel">
      <div class="stat">
        <span>模式:</span>
        <strong>{{ topologyMode }}</strong>
      </div>
      <div class="stat">
        <span>节点数:</span>
        <strong>{{ peers.length + 1 }}</strong>
      </div>
      <div class="stat">
        <span>连接数:</span>
        <strong>{{ currentConnections }}</strong>
      </div>
      <div class="stat">
        <span>全连接需要:</span>
        <strong>{{ fullMeshConnections }}</strong>
      </div>
      <div class="stat" v-if="topologyMode !== 'full-mesh'">
        <span>优化:</span>
        <strong class="success">
          -{{ ((1 - currentConnections / fullMeshConnections) * 100).toFixed(0) }}%
        </strong>
      </div>
    </div>
  </div>
</template>
```

---

## 🎨 可视化元素说明

### 节点样式

| 角色 | 颜色 | 外圈 | 标签 |
|------|------|------|------|
| 我 | 紫色 #6c4bf4 | 有（紫色） | 粗体 |
| 根节点/组长 | 橙色 #f59e0b | 有（橙色） | "根节点"/"组长" |
| 普通成员 | 绿色 #10b981 | 无 | 普通 |

### 连接样式

| 类型 | 颜色 | 宽度 | 说明 |
|------|------|------|------|
| 直连 | 蓝色 #93c5fd | 1px | 全连接、组内连接 |
| 中继 | 黄色 #fbbf24 | 2px | 组长之间 |
| 父子 | 绿色 #86efac | 2px | 树状结构 |

### 统计面板

显示内容：
- **节点数**：当前网络总节点数
- **连接数**：当前实际连接数
- **全连接需要**：如果用全连接需要的连接数
- **优化**：连接数优化百分比

### 图例

自动显示当前模式相关的节点和连接类型。

---

## 📱 响应式设计

组件支持自适应尺寸：
- 自动检测容器大小
- 响应容器尺寸变化
- 支持深色模式

```css
/* 自定义容器大小 */
.topology-container {
  width: 100%;
  height: 600px; /* 或使用 vh */
}

/* 全屏模式 */
.topology-fullscreen {
  width: 100vw;
  height: 100vh;
}

/* 侧边栏 */
.topology-sidebar {
  width: 400px;
  height: 500px;
}
```

---

## 🔧 高级配置

### 自定义布局参数

虽然当前版本使用固定布局算法，但可以通过修改组件来自定义：

```typescript
// 在 TopologyGraph.vue 中
// 全连接圆形半径
const radius = Math.min(width.value, height.value) * 0.35 // 调整系数

// 分层模式组间距
const groupWidth = width.value / (groupCount + 1) // 调整间距

// 树状模式层高
const levelHeight = height.value / 10 // 调整层高
```

### 交互增强（未来版本）

计划添加的交互功能：
- [ ] 节点拖拽重新布局
- [ ] 点击节点查看详情
- [ ] 鼠标悬停显示 RTT
- [ ] 缩放和平移
- [ ] 导出为图片

---

## 🚀 性能优化

### 大规模网络（100+ 节点）

当节点数超过 100 时，建议：

1. **简化边的渲染**
```vue
<!-- 只渲染关键连接 -->
<line
  v-for="(edge, i) in criticalEdges"
  :key="i"
  ...
/>
```

2. **虚拟化长列表**
```typescript
// 只渲染可视区域内的节点
const visibleNodes = computed(() => {
  return nodes.value.filter(node => 
    node.x >= 0 && node.x <= width.value &&
    node.y >= 0 && node.y <= height.value
  )
})
```

3. **使用 Canvas 替代 SVG**
```typescript
// 对于超大规模网络（500+），考虑使用 Canvas
// Canvas 性能更好，但交互性较差
```

---

## 📊 实时更新

监听拓扑变化并更新可视化：

```typescript
// 监听拓扑更新
mesh.on('topology-groups', (groups) => {
  topologyGroups.value = groups
})

mesh.on('topology-mode', (mode) => {
  topologyMode.value = mode
})

mesh.on('peer-rtt', ({ peerId, rtt }) => {
  // 更新 RTT 显示
  updatePeerRtt(peerId, rtt)
})
```

---

## 🎯 使用场景示例

### 1. 会议室网络监控

```vue
<template>
  <div class="meeting-monitor">
    <h2>会议室网络状态</h2>
    
    <!-- 拓扑图 -->
    <TopologyGraph
      :mode="room.topologyMode"
      :myId="room.myId"
      :peers="room.peers"
      :groups="room.topologyGroups"
    />

    <!-- 连接质量 -->
    <div class="quality-panel">
      <div v-for="peer in room.peers" :key="peer.id">
        <span>{{ peer.nick }}</span>
        <span :class="getRttClass(peer.rtt)">
          {{ peer.rtt }}ms
        </span>
      </div>
    </div>
  </div>
</template>
```

### 2. 管理员控制面板

```vue
<template>
  <div class="admin-panel">
    <h2>网络管理</h2>
    
    <!-- 模式切换 -->
    <select v-model="selectedMode">
      <option value="full-mesh">全连接</option>
      <option value="hierarchical">分层</option>
      <option value="tree">树状</option>
    </select>

    <!-- 拓扑图 -->
    <TopologyGraph
      :mode="selectedMode"
      :myId="myId"
      :peers="allPeers"
    />

    <!-- 性能指标 -->
    <div class="metrics">
      <div>总带宽: {{ totalBandwidth }} MB/s</div>
      <div>平均延迟: {{ avgLatency }} ms</div>
      <div>连接数: {{ connectionCount }}</div>
    </div>
  </div>
</template>
```

---

## 🐛 故障排查

### 问题：图形不显示

**检查：**
```javascript
console.log('Nodes:', nodes.value)
console.log('Edges:', edges.value)
console.log('Container size:', width.value, height.value)
```

**原因：**
- 容器高度为 0
- 节点数据为空
- 模式不匹配

**解决：**
```css
.topology-container {
  min-height: 400px; /* 确保有高度 */
}
```

### 问题：节点重叠

**原因：**布局算法需要调整

**解决：**
```typescript
// 增加节点间距
const radius = Math.min(width.value, height.value) * 0.4 // 增大半径
```

### 问题：边太多看不清

**解决：**
```vue
<!-- 添加透明度 -->
<line
  ...
  stroke-opacity="0.3"
/>

<!-- 或只显示选中节点的连接 -->
<line
  v-for="edge in selectedEdges"
  ...
/>
```

---

## 📚 相关文档

- [拓扑模式对比](./TOPOLOGY_COMPARISON.md)
- [树状拓扑设计](./TOPOLOGY_TREE_DESIGN.md)
- [使用指南](./TOPOLOGY_GUIDE.md)
- [快速开始](./TOPOLOGY_QUICKSTART.md)

---

## 🎉 总结

现在 pphub 具备：

✅ **更高的人数限制** - 默认 100 人（可配置到 500+）
✅ **直观的拓扑可视化** - 自动适配三种模式
✅ **实时统计展示** - 连接数、优化效果
✅ **响应式设计** - 支持各种屏幕尺寸

**下次启动服务时，房间人数限制将自动提升到 100 人！** 🚀
