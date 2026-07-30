<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

type TopologyMode = 'full-mesh' | 'hierarchical' | 'tree'

interface NetworkGroup {
  id: string
  leader: string
  members: Set<string>
}

interface Node {
  id: string
  nick: string
  x: number
  y: number
  role?: 'root' | 'leader' | 'member' | 'me'
  level?: number
  groupId?: string
}

interface Edge {
  from: string
  to: string
  rtt?: number
  type: 'direct' | 'relay' | 'parent-child'
}

const props = defineProps<{
  mode: TopologyMode
  myId: string
  peers: Array<{ peerId: string; nick: string; rtt?: number; state: string }>
  groups?: NetworkGroup[]
  treeInfo?: {
    root: string | null
    parent: string | null
    children: Set<string>
    level: number
  }
}>()

const container = ref<HTMLElement>()
const width = ref(800)
const height = ref(600)

// 计算节点和边
const nodes = computed<Node[]>(() => {
  const result: Node[] = []
  const allPeers = [
    { peerId: props.myId, nick: '我', state: 'connected' },
    ...props.peers,
  ]

  if (props.mode === 'full-mesh') {
    // 全连接：圆形布局
    const radius = Math.min(width.value, height.value) * 0.35
    const cx = width.value / 2
    const cy = height.value / 2
    const angleStep = (2 * Math.PI) / allPeers.length

    allPeers.forEach((peer, i) => {
      const angle = i * angleStep - Math.PI / 2
      result.push({
        id: peer.peerId,
        nick: peer.nick || peer.peerId.slice(0, 8),
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        role: peer.peerId === props.myId ? 'me' : 'member',
      })
    })
  } else if (props.mode === 'hierarchical' && props.groups) {
    // 分层：按组分布
    const groupCount = props.groups.length
    const groupWidth = width.value / (groupCount + 1)

    props.groups.forEach((group, gIndex) => {
      const members = Array.from(group.members)
      const groupX = (gIndex + 1) * groupWidth
      const memberHeight = height.value / (members.length + 1)

      members.forEach((memberId, mIndex) => {
        const peer = allPeers.find((p) => p.peerId === memberId)
        if (!peer) return

        let role: Node['role'] = 'member'
        if (memberId === props.myId) role = 'me'
        else if (memberId === group.leader) role = 'leader'

        result.push({
          id: memberId,
          nick: peer.nick || memberId.slice(0, 8),
          x: groupX,
          y: (mIndex + 1) * memberHeight,
          role,
          groupId: group.id,
        })
      })
    })
  } else if (props.mode === 'tree' && props.treeInfo) {
    // 树状：层级布局
    const levelHeight = height.value / 10
    const levelMap = new Map<string, number>()

    // 构建层级信息（简化版）
    levelMap.set(props.myId, props.treeInfo.level)
    props.peers.forEach((peer) => {
      // 这里需要从实际的树拓扑获取层级信息
      levelMap.set(peer.peerId, 0) // 临时值
    })

    // 按层级分组
    const levels = new Map<number, string[]>()
    allPeers.forEach((peer) => {
      const level = levelMap.get(peer.peerId) ?? 0
      if (!levels.has(level)) levels.set(level, [])
      levels.get(level)!.push(peer.peerId)
    })

    // 布局
    levels.forEach((peerIds, level) => {
      const levelWidth = width.value / (peerIds.length + 1)
      peerIds.forEach((peerId, index) => {
        const peer = allPeers.find((p) => p.peerId === peerId)
        if (!peer) return

        let role: Node['role'] = 'member'
        if (peerId === props.myId) role = 'me'
        else if (peerId === props.treeInfo?.root) role = 'root'

        result.push({
          id: peerId,
          nick: peer.nick || peerId.slice(0, 8),
          x: (index + 1) * levelWidth,
          y: 80 + level * levelHeight,
          role,
          level,
        })
      })
    })
  }

  return result
})

const edges = computed<Edge[]>(() => {
  const result: Edge[] = []

  if (props.mode === 'full-mesh') {
    // 全连接：所有节点两两连接
    for (let i = 0; i < nodes.value.length; i++) {
      for (let j = i + 1; j < nodes.value.length; j++) {
        const from = nodes.value[i]
        const to = nodes.value[j]
        const peer = props.peers.find((p) => p.peerId === to.id || p.peerId === from.id)

        result.push({
          from: from.id,
          to: to.id,
          rtt: peer?.rtt,
          type: 'direct',
        })
      }
    }
  } else if (props.mode === 'hierarchical' && props.groups) {
    // 分层：组内全连接 + 组长之间连接
    const leaders = new Set(props.groups.map((g) => g.leader))

    props.groups.forEach((group) => {
      const members = Array.from(group.members)

      // 组内连接
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const peer = props.peers.find((p) => p.peerId === members[j])
          result.push({
            from: members[i],
            to: members[j],
            rtt: peer?.rtt,
            type: 'direct',
          })
        }
      }
    })

    // 组长之间连接
    const leaderList = Array.from(leaders)
    for (let i = 0; i < leaderList.length; i++) {
      for (let j = i + 1; j < leaderList.length; j++) {
        result.push({
          from: leaderList[i],
          to: leaderList[j],
          type: 'relay',
        })
      }
    }
  } else if (props.mode === 'tree' && props.treeInfo) {
    // 树状：父子连接
    if (props.treeInfo.parent) {
      result.push({
        from: props.myId,
        to: props.treeInfo.parent,
        type: 'parent-child',
      })
    }

    props.treeInfo.children.forEach((child) => {
      result.push({
        from: props.myId,
        to: child,
        type: 'parent-child',
      })
    })
  }

  return result
})

// SVG 路径
const getNodePosition = (id: string) => {
  const node = nodes.value.find((n) => n.id === id)
  return node ? { x: node.x, y: node.y } : null
}

const getNodeColor = (role?: Node['role']) => {
  switch (role) {
    case 'me':
      return '#6c4bf4'
    case 'root':
    case 'leader':
      return '#f59e0b'
    default:
      return '#10b981'
  }
}

const getEdgeColor = (type: Edge['type']) => {
  switch (type) {
    case 'direct':
      return '#93c5fd'
    case 'relay':
      return '#fbbf24'
    case 'parent-child':
      return '#86efac'
    default:
      return '#cbd5e1'
  }
}

const getEdgeWidth = (type: Edge['type']) => {
  return type === 'relay' || type === 'parent-child' ? 2 : 1
}

// 响应式尺寸
onMounted(() => {
  if (container.value) {
    const rect = container.value.getBoundingClientRect()
    width.value = rect.width
    height.value = rect.height
  }

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      width.value = entry.contentRect.width
      height.value = entry.contentRect.height
    }
  })

  if (container.value) {
    resizeObserver.observe(container.value)
  }

  return () => resizeObserver.disconnect()
})

// 统计信息
const stats = computed(() => {
  return {
    nodeCount: nodes.value.length,
    edgeCount: edges.value.length,
    maxTheoretical: (nodes.value.length * (nodes.value.length - 1)) / 2,
    efficiency: edges.value.length > 0
      ? (1 - edges.value.length / ((nodes.value.length * (nodes.value.length - 1)) / 2)) * 100
      : 0,
  }
})
</script>

<template>
  <div class="topology-graph" ref="container">
    <svg :width="width" :height="height" class="graph-svg">
      <!-- 背景 -->
      <defs>
        <pattern
          id="grid"
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 20 0 L 0 0 0 20"
            fill="none"
            stroke="rgba(0,0,0,0.05)"
            stroke-width="0.5"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />

      <!-- 边 -->
      <g class="edges">
        <line
          v-for="(edge, i) in edges"
          :key="i"
          :x1="getNodePosition(edge.from)?.x"
          :y1="getNodePosition(edge.from)?.y"
          :x2="getNodePosition(edge.to)?.x"
          :y2="getNodePosition(edge.to)?.y"
          :stroke="getEdgeColor(edge.type)"
          :stroke-width="getEdgeWidth(edge.type)"
          stroke-opacity="0.6"
          class="edge"
        />
      </g>

      <!-- 节点 -->
      <g class="nodes">
        <g
          v-for="node in nodes"
          :key="node.id"
          :transform="`translate(${node.x}, ${node.y})`"
          class="node"
        >
          <!-- 外圈（角色指示） -->
          <circle
            v-if="node.role === 'me' || node.role === 'root' || node.role === 'leader'"
            r="28"
            :fill="getNodeColor(node.role)"
            opacity="0.2"
          />

          <!-- 主圆 -->
          <circle
            r="20"
            :fill="getNodeColor(node.role)"
            :stroke="node.role === 'me' ? '#4c1d95' : 'white'"
            :stroke-width="node.role === 'me' ? 3 : 2"
            class="node-circle"
          />

          <!-- 标签 -->
          <text
            y="40"
            text-anchor="middle"
            class="node-label"
            :fill="node.role === 'me' ? '#6c4bf4' : '#374151'"
          >
            {{ node.nick }}
          </text>

          <!-- 角色标签 -->
          <text
            v-if="node.role === 'root'"
            y="-35"
            text-anchor="middle"
            class="role-label"
            fill="#f59e0b"
          >
            根节点
          </text>
          <text
            v-else-if="node.role === 'leader'"
            y="-35"
            text-anchor="middle"
            class="role-label"
            fill="#f59e0b"
          >
            组长
          </text>
        </g>
      </g>
    </svg>

    <!-- 统计信息 -->
    <div class="stats-overlay">
      <div class="stat-item">
        <span class="label">节点:</span>
        <span class="value">{{ stats.nodeCount }}</span>
      </div>
      <div class="stat-item">
        <span class="label">连接:</span>
        <span class="value">{{ stats.edgeCount }}</span>
        <span class="detail">/ {{ stats.maxTheoretical }}</span>
      </div>
      <div class="stat-item" v-if="mode !== 'full-mesh'">
        <span class="label">优化:</span>
        <span class="value success">-{{ stats.efficiency.toFixed(0) }}%</span>
      </div>
    </div>

    <!-- 图例 -->
    <div class="legend">
      <div class="legend-item">
        <div class="legend-node" style="background: #6c4bf4"></div>
        <span>我</span>
      </div>
      <div class="legend-item" v-if="mode === 'hierarchical' || mode === 'tree'">
        <div class="legend-node" style="background: #f59e0b"></div>
        <span>{{ mode === 'tree' ? '根节点' : '组长' }}</span>
      </div>
      <div class="legend-item">
        <div class="legend-node" style="background: #10b981"></div>
        <span>成员</span>
      </div>
      <div class="legend-item">
        <div class="legend-line" style="background: #93c5fd"></div>
        <span>直连</span>
      </div>
      <div class="legend-item" v-if="mode === 'hierarchical'">
        <div class="legend-line" style="background: #fbbf24"></div>
        <span>中继</span>
      </div>
      <div class="legend-item" v-if="mode === 'tree'">
        <div class="legend-line" style="background: #86efac"></div>
        <span>父子</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.topology-graph {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 400px;
  background: #f9fafb;
  border-radius: 8px;
  overflow: hidden;
}

.graph-svg {
  display: block;
}

.edge {
  transition: stroke-opacity 0.2s;
}

.edge:hover {
  stroke-opacity: 1;
}

.node {
  cursor: pointer;
  transition: transform 0.2s;
}

.node:hover {
  transform: scale(1.1);
}

.node-circle {
  transition: all 0.2s;
}

.node:hover .node-circle {
  filter: brightness(1.1);
}

.node-label {
  font-size: 12px;
  font-weight: 500;
  pointer-events: none;
  user-select: none;
}

.role-label {
  font-size: 10px;
  font-weight: 600;
  pointer-events: none;
  user-select: none;
}

.stats-overlay {
  position: absolute;
  top: 16px;
  right: 16px;
  background: white;
  padding: 12px 16px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.stat-item .label {
  color: #6b7280;
  font-weight: 500;
}

.stat-item .value {
  color: #111827;
  font-weight: 700;
}

.stat-item .value.success {
  color: #10b981;
}

.stat-item .detail {
  color: #9ca3af;
  font-size: 12px;
}

.legend {
  position: absolute;
  bottom: 16px;
  left: 16px;
  background: white;
  padding: 12px 16px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b7280;
}

.legend-node {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid white;
}

.legend-line {
  width: 20px;
  height: 2px;
}

@media (prefers-color-scheme: dark) {
  .topology-graph {
    background: #1f2937;
  }

  .stats-overlay,
  .legend {
    background: #374151;
  }

  .stat-item .label,
  .legend-item {
    color: #9ca3af;
  }

  .stat-item .value {
    color: #f3f4f6;
  }

  .node-label {
    fill: #f3f4f6;
  }
}
</style>
