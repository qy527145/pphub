<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useRoomStore, type View } from '@/stores/room'
import SideNav from '@/components/SideNav.vue'
import NetworkView from '@/components/NetworkView.vue'
import SendView from '@/components/SendView.vue'
import ReceiveView from '@/components/ReceiveView.vue'
import ChatView from '@/components/ChatView.vue'
import ScreenView from '@/components/ScreenView.vue'
import BoardView from '@/components/BoardView.vue'
import GameLobby from '@/components/GameLobby.vue'
import InviteNotification from '@/components/InviteNotification.vue'

const store = useRoomStore()

// E2E 冒烟测试直接读 store 状态（scripts/e2e-*.mjs），对用户无感。
;(window as unknown as { __pphub: unknown }).__pphub = store

// 管理浏览器历史记录与导航状态
let isRestoringFromHistory = false

function handlePopState(event: PopStateEvent) {
  isRestoringFromHistory = true
  const state = event.state as { view?: View } | null
  if (state?.view) {
    store.setView(state.view)
  } else {
    // 没有状态时默认回到网络页
    store.setView('network')
  }
  isRestoringFromHistory = false
}

onMounted(() => {
  void store.init()

  // 初始化历史记录状态
  if (!history.state?.view) {
    history.replaceState({ view: store.activeView }, '')
  }

  // 监听浏览器前进/后退按钮
  window.addEventListener('popstate', handlePopState)
})

onUnmounted(() => {
  window.removeEventListener('popstate', handlePopState)
})

// 监听视图切换，同步到浏览器历史
watch(() => store.activeView, (newView, oldView) => {
  // 避免在恢复历史记录时重复推送
  if (!isRestoringFromHistory && newView !== oldView) {
    history.pushState({ view: newView }, '')
  }
})
</script>

<template>
  <div class="app">
    <SideNav />
    <main class="main">
      <NetworkView v-if="store.activeView === 'network'" />
      <SendView v-else-if="store.activeView === 'send'" />
      <ReceiveView v-else-if="store.activeView === 'receive'" />
      <ScreenView v-else-if="store.activeView === 'screen'" />
      <BoardView v-else-if="store.activeView === 'board'" />
      <GameLobby v-else-if="store.activeView === 'games'" />
      <ChatView v-else />
    </main>

    <!-- 邀请通知（全局浮动） -->
    <InviteNotification />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
