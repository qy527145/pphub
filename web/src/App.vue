<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoomStore } from '@/stores/room'
import SideNav from '@/components/SideNav.vue'
import NetworkView from '@/components/NetworkView.vue'
import SendView from '@/components/SendView.vue'
import ReceiveView from '@/components/ReceiveView.vue'
import ChatView from '@/components/ChatView.vue'
import ScreenView from '@/components/ScreenView.vue'
import BoardView from '@/components/BoardView.vue'

const store = useRoomStore()

// E2E 冒烟测试直接读 store 状态（scripts/e2e-*.mjs），对用户无感。
;(window as unknown as { __pphub: unknown }).__pphub = store

onMounted(() => {
  void store.init()
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
      <ChatView v-else />
    </main>
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
