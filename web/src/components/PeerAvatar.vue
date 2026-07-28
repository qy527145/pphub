<script setup lang="ts">
// 节点头像：emoji 带底色，或用户上传的小图。全应用统一形态。
import { computed } from 'vue'
import type { Avatar } from '@/core/messages'
import { randomAvatar } from '@/core/profile'

const props = defineProps<{
  avatar?: Avatar | null
  /** 无名片时用 peerId 派生稳定的默认头像。 */
  seed?: string
  size?: number
}>()

const a = computed<Avatar>(() => props.avatar ?? randomAvatar(props.seed ?? '?'))
const px = computed(() => props.size ?? 40)
</script>

<template>
  <span
    class="avatar"
    :style="{
      width: `${px}px`,
      height: `${px}px`,
      background: a.kind === 'emoji' ? a.color : 'var(--panel-2)',
      fontSize: `${px * 0.52}px`,
    }"
  >
    <img v-if="a.kind === 'image'" :src="a.value" alt="" />
    <template v-else>{{ a.value }}</template>
  </span>
</template>

<style scoped>
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  overflow: hidden;
  flex: none;
  user-select: none;
  line-height: 1;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
