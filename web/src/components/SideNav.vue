<script setup lang="ts">
import { useRoomStore, type View } from '@/stores/room'
import { THEMES } from '@/core/theme'
import AppIcon from './AppIcon.vue'

const store = useRoomStore()

interface NavItem {
  view: View
  icon: string
  label: string
  badge?: () => number
}

const NAV: NavItem[] = [
  { view: 'network', icon: 'hub', label: '网络' },
  { view: 'send', icon: 'upload', label: '发送文件' },
  { view: 'receive', icon: 'download', label: '接收文件', badge: () => store.unseenRecv },
  { view: 'chat', icon: 'chat', label: '消息', badge: () => store.unreadTotal },
  { view: 'screen', icon: 'monitor', label: '屏幕共享', badge: () => store.unseenShare },
  { view: 'board', icon: 'pen', label: '互动白板' },
]

/** 路线图上后续 Phase 的能力，先占位展示（ARCHITECTURE.md §九）。 */
const PLANNED = [
  { icon: 'play', label: '一起看片' },
  { icon: 'clipboard', label: '云剪贴板' },
]

const SIG_LABEL: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中',
  open: '在线',
  closed: '已断线',
}
</script>

<template>
  <aside class="sidenav">
    <div class="brand">
      <span class="mark" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M10 11.5v9" />
            <path d="M22 11.5v9" />
            <path d="M10 16h12" />
          </g>
          <circle cx="10" cy="8.6" r="2.7" fill="currentColor" />
          <circle cx="22" cy="23.4" r="2.7" fill="currentColor" />
        </svg>
      </span>
      <div class="brand-text">
        <strong>pphub</strong>
        <span>点对点直连</span>
      </div>
    </div>

    <nav class="nav">
      <button
        v-for="item in NAV"
        :key="item.view"
        class="nav-item"
        :class="{ active: store.activeView === item.view }"
        @click="store.setView(item.view)"
      >
        <span class="rail" aria-hidden="true"></span>
        <AppIcon :name="item.icon" :size="19" />
        <span class="label">{{ item.label }}</span>
        <span v-if="item.badge && item.badge() > 0" class="badge">{{ item.badge() }}</span>
      </button>

      <div class="divider"></div>

      <div v-for="item in PLANNED" :key="item.label" class="nav-item planned" title="规划中，敬请期待">
        <AppIcon :name="item.icon" :size="19" />
        <span class="label">{{ item.label }}</span>
        <span class="soon">规划中</span>
      </div>
    </nav>

    <div class="foot">
      <div class="theme" role="group" aria-label="主题">
        <button
          v-for="t in THEMES"
          :key="t.id"
          class="theme-btn"
          :class="{ on: store.theme === t.id }"
          :title="`${t.label}主题`"
          :aria-pressed="store.theme === t.id"
          @click="store.setTheme(t.id)"
        >
          <AppIcon :name="t.icon" :size="15" />
          <span class="theme-label">{{ t.label }}</span>
        </button>
      </div>

      <div class="status">
        <span class="dot" :class="store.signalingState"></span>
        <span>{{ SIG_LABEL[store.signalingState] ?? store.signalingState }}</span>
        <span v-if="store.status === 'online'" class="room">
          {{ store.listening ? `短码 ${store.myCode}` : `房间 ${store.room}` }}
        </span>
      </div>
      <div class="device" :title="store.myProfile.nick">{{ store.myProfile.nick }}</div>
    </div>
  </aside>
</template>

<style scoped>
.sidenav {
  width: 232px;
  flex: none;
  background: var(--panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 18px 12px 12px;
}

/* —— 品牌 —— */
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 6px 20px;
}

.mark {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 11px;
  background: var(--brand-grad);
  color: #fff;
  display: grid;
  place-items: center;
  box-shadow: var(--shadow-soft);
}

.mark svg {
  width: 26px;
  height: 26px;
}

.brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.2;
}

.brand-text strong {
  font-size: 18px;
  letter-spacing: -0.2px;
}

.brand-text span {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

/* —— 导航 —— */
.nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: 14px;
  text-align: left;
}

.rail {
  position: absolute;
  left: 0;
  top: 50%;
  width: 3px;
  height: 0;
  border-radius: var(--radius-pill);
  background: var(--accent);
  transform: translateY(-50%);
  transition: height var(--dur);
}

.nav-item:hover:not(.planned) {
  background: var(--panel-2);
  color: var(--text);
}

.nav-item.active {
  background: var(--accent-weak);
  color: var(--accent-strong);
  font-weight: 600;
}

.nav-item.active .rail {
  height: 18px;
}

.nav-item .label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
}

.badge {
  background: var(--danger);
  color: #fff;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 7px;
}

.divider {
  height: 1px;
  background: var(--border);
  margin: 10px 8px;
}

.nav-item.planned {
  color: var(--faint);
  cursor: default;
}

.soon {
  font-size: 10px;
  color: var(--faint);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 5px;
  white-space: nowrap;
}

/* —— 底部：主题 + 状态 —— */
.foot {
  border-top: 1px solid var(--border);
  padding: 12px 6px 0;
  font-size: 12px;
  color: var(--muted);
}

.theme {
  display: flex;
  gap: 3px;
  padding: 3px;
  background: var(--panel-2);
  border-radius: var(--radius-sm);
  margin-bottom: 12px;
}

.theme-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 4px;
  border: none;
  background: transparent;
  border-radius: 7px;
  color: var(--muted);
  font-size: 12px;
}

.theme-btn:hover:not(.on) {
  color: var(--text);
  background: var(--panel-3);
}

.theme-btn.on {
  background: var(--panel);
  color: var(--accent-strong);
  font-weight: 600;
  box-shadow: var(--shadow-soft);
}

.status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--border-strong);
  flex: none;
}

.dot.open {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-weak);
}

.dot.connecting {
  background: var(--warn);
}

.dot.closed {
  background: var(--danger);
}

.room {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.device {
  margin-top: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .sidenav {
    width: 62px;
    padding: 14px 8px 10px;
    align-items: center;
  }

  .brand {
    padding: 0 0 16px;
  }

  .brand-text,
  .nav-item .label,
  .soon,
  .status,
  .device,
  .theme-label {
    display: none;
  }

  .nav-item {
    justify-content: center;
    padding: 12px 0;
  }

  .foot {
    width: 100%;
    padding: 10px 0 0;
  }

  .theme {
    flex-direction: column;
    margin-bottom: 0;
  }
}
</style>
