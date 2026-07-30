<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TopologyMode, NetworkGroup } from '../core/topology'

const props = defineProps<{
  mode: TopologyMode
  stats: {
    mode: TopologyMode
    totalPeers: number
    totalGroups: number
    avgGroupSize: number
    myGroupSize: number
    isLeader: boolean
    requiredConnections: number
  }
  groups: NetworkGroup[]
}>()

const emit = defineEmits<{
  'update:mode': [mode: TopologyMode]
}>()

const localMode = ref<TopologyMode>(props.mode)

watch(() => props.mode, (newMode) => {
  localMode.value = newMode
})

const handleModeChange = () => {
  emit('update:mode', localMode.value)
}

const fullMeshConnections = computed(() => {
  const n = props.stats.totalPeers
  return n > 0 ? (n * (n - 1)) / 2 : 0
})

const hierarchicalConnections = computed(() => {
  return props.stats.requiredConnections
})

const connectionSavings = computed(() => {
  if (fullMeshConnections.value === 0) return 0
  const saved = fullMeshConnections.value - hierarchicalConnections.value
  return Math.round((saved / fullMeshConnections.value) * 100)
})

const getGroupColor = (index: number): string => {
  const colors = [
    '#6c4bf4', '#f44b4b', '#4bf4a8', '#f4c44b',
    '#4ba8f4', '#f44bc4', '#a8f44b', '#c44bf4'
  ]
  return colors[index % colors.length]
}
</script>

<template>
  <div class="topology-settings">
    <div class="header">
      <h3>🌐 网络拓扑</h3>
      <span class="badge" :class="mode === 'hierarchical' ? 'badge-success' : 'badge-default'">
        {{ mode === 'hierarchical' ? '分层模式' : '全连接模式' }}
      </span>
    </div>

    <div class="mode-selector">
      <label class="mode-option">
        <input
          type="radio"
          value="full-mesh"
          v-model="localMode"
          @change="handleModeChange"
        />
        <div class="mode-content">
          <div class="mode-title">全连接 (Full Mesh)</div>
          <div class="mode-desc">每个节点与所有其他节点直连，延迟最低但连接数多</div>
        </div>
      </label>

      <label class="mode-option">
        <input
          type="radio"
          value="hierarchical"
          v-model="localMode"
          @change="handleModeChange"
        />
        <div class="mode-content">
          <div class="mode-title">分层拓扑 (Hierarchical)</div>
          <div class="mode-desc">同组内全连接，跨组通过组长中继，适合大规模网络</div>
        </div>
      </label>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">总节点数</div>
        <div class="stat-value">{{ stats.totalPeers }}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">当前连接数</div>
        <div class="stat-value">
          {{ mode === 'hierarchical' ? hierarchicalConnections : fullMeshConnections }}
        </div>
      </div>

      <div class="stat-card" v-if="mode === 'hierarchical'">
        <div class="stat-label">全连接需要</div>
        <div class="stat-value dimmed">{{ fullMeshConnections }}</div>
      </div>

      <div class="stat-card" v-if="mode === 'hierarchical' && connectionSavings > 0">
        <div class="stat-label">连接优化</div>
        <div class="stat-value success">-{{ connectionSavings }}%</div>
      </div>

      <div class="stat-card" v-if="mode === 'hierarchical'">
        <div class="stat-label">网络分组</div>
        <div class="stat-value">{{ stats.totalGroups }}</div>
      </div>

      <div class="stat-card" v-if="mode === 'hierarchical'">
        <div class="stat-label">我的组大小</div>
        <div class="stat-value">{{ stats.myGroupSize }}</div>
      </div>

      <div class="stat-card" v-if="mode === 'hierarchical'">
        <div class="stat-label">我的角色</div>
        <div class="stat-value">
          {{ stats.isLeader ? '🌟 组长' : '👤 组员' }}
        </div>
      </div>

      <div class="stat-card" v-if="mode === 'hierarchical' && stats.totalGroups > 0">
        <div class="stat-label">平均组大小</div>
        <div class="stat-value">{{ stats.avgGroupSize.toFixed(1) }}</div>
      </div>
    </div>

    <div v-if="mode === 'hierarchical' && groups.length > 0" class="groups-section">
      <h4>分组详情</h4>
      <div class="groups-list">
        <div
          v-for="(group, index) in groups"
          :key="group.id"
          class="group-card"
          :style="{ borderLeftColor: getGroupColor(index) }"
        >
          <div class="group-header">
            <span class="group-name">组 {{ index + 1 }}</span>
            <span class="group-size">{{ group.members.size }} 人</span>
          </div>
          <div class="group-info">
            <div class="info-item">
              <span class="label">组长:</span>
              <span class="value">{{ group.leader.slice(0, 8) }}</span>
            </div>
            <div class="info-item">
              <span class="label">平均延迟:</span>
              <span class="value">{{ group.avgRtt.toFixed(0) }}ms</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="info-box">
      <div class="info-title">💡 提示</div>
      <ul class="info-list">
        <li v-if="mode === 'full-mesh'">
          全连接模式适合小规模网络（&lt;10人），所有节点直连，延迟最低
        </li>
        <li v-if="mode === 'hierarchical'">
          分层模式适合大规模网络（10+人），自动根据网络延迟分组
        </li>
        <li v-if="mode === 'hierarchical'">
          同一局域网的节点会被分到同一组，组内全连接
        </li>
        <li v-if="mode === 'hierarchical'">
          不同组之间通过组长中继消息，减少连接数
        </li>
        <li v-if="mode === 'hierarchical' && stats.isLeader">
          你是组长，负责中转跨组流量
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.topology-settings {
  padding: 1rem;
  max-width: 800px;
  margin: 0 auto;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.header h3 {
  margin: 0;
  font-size: 1.5rem;
}

.badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.875rem;
  font-weight: 500;
}

.badge-success {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.badge-default {
  background: rgba(156, 163, 175, 0.1);
  color: #6b7280;
}

.mode-selector {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.mode-option {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem;
  border: 2px solid rgba(156, 163, 175, 0.2);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.mode-option:hover {
  border-color: #6c4bf4;
  background: rgba(108, 75, 244, 0.05);
}

.mode-option input[type="radio"] {
  margin-top: 0.125rem;
  cursor: pointer;
}

.mode-option input[type="radio"]:checked + .mode-content {
  color: #6c4bf4;
}

.mode-content {
  flex: 1;
}

.mode-title {
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.mode-desc {
  font-size: 0.875rem;
  color: #6b7280;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.stat-card {
  padding: 1rem;
  background: rgba(156, 163, 175, 0.05);
  border-radius: 8px;
  text-align: center;
}

.stat-label {
  font-size: 0.75rem;
  color: #6b7280;
  margin-bottom: 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.stat-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: #111827;
}

.stat-value.dimmed {
  color: #9ca3af;
}

.stat-value.success {
  color: #10b981;
}

.groups-section {
  margin-bottom: 1.5rem;
}

.groups-section h4 {
  margin: 0 0 1rem 0;
  font-size: 1rem;
}

.groups-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.group-card {
  padding: 1rem;
  background: rgba(156, 163, 175, 0.05);
  border-radius: 8px;
  border-left: 4px solid;
}

.group-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.group-name {
  font-weight: 600;
}

.group-size {
  font-size: 0.875rem;
  color: #6b7280;
}

.group-info {
  display: flex;
  gap: 1.5rem;
}

.info-item {
  display: flex;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.info-item .label {
  color: #6b7280;
}

.info-item .value {
  font-weight: 500;
  font-family: monospace;
}

.info-box {
  padding: 1rem;
  background: rgba(59, 130, 246, 0.05);
  border: 1px solid rgba(59, 130, 246, 0.2);
  border-radius: 8px;
}

.info-title {
  font-weight: 600;
  margin-bottom: 0.75rem;
}

.info-list {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.875rem;
  color: #374151;
}

.info-list li {
  margin-bottom: 0.5rem;
}

.info-list li:last-child {
  margin-bottom: 0;
}

@media (prefers-color-scheme: dark) {
  .mode-desc,
  .stat-label,
  .group-size,
  .info-item .label {
    color: #9ca3af;
  }

  .stat-value,
  .info-list {
    color: #f3f4f6;
  }

  .stat-card,
  .group-card {
    background: rgba(255, 255, 255, 0.05);
  }

  .mode-option {
    border-color: rgba(255, 255, 255, 0.1);
  }

  .mode-option:hover {
    background: rgba(108, 75, 244, 0.1);
  }

  .info-box {
    background: rgba(59, 130, 246, 0.1);
    border-color: rgba(59, 130, 246, 0.3);
  }
}
</style>
