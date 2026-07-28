<script setup lang="ts">
// 单路屏幕画面：video + 按 object-fit contain 内容区对齐的批注层。
// 几何自理（ResizeObserver + loadedmetadata），供焦点视图与多画面平铺复用。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { containRect } from '@/core/draw'
import type { DrawMode } from '@/core/messages'
import DrawLayer from './DrawLayer.vue'

const props = defineProps<{
  stream: MediaStream
  board: string
  tool: 'pointer' | DrawMode
  color: string
  size: number
  polylineArrow?: boolean
  muted?: boolean
}>()

const rootEl = ref<HTMLDivElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const layerRef = ref<InstanceType<typeof DrawLayer> | null>(null)

const stageW = ref(0)
const stageH = ref(0)
const videoW = ref(0)
const videoH = ref(0)
const content = computed(() => containRect(stageW.value, stageH.value, videoW.value, videoH.value))

let resizeObs: ResizeObserver | null = null

onMounted(() => {
  resizeObs = new ResizeObserver(() => {
    if (!rootEl.value) return
    stageW.value = rootEl.value.clientWidth
    stageH.value = rootEl.value.clientHeight
  })
  if (rootEl.value) resizeObs.observe(rootEl.value)
})

onBeforeUnmount(() => resizeObs?.disconnect())

function onVideoMeta(): void {
  const v = videoEl.value
  if (!v) return
  videoW.value = v.videoWidth
  videoH.value = v.videoHeight
}

watch(
  [() => props.stream, videoEl],
  () => {
    const v = videoEl.value
    if (!v) return
    if (v.srcObject !== props.stream) {
      videoW.value = 0
      videoH.value = 0
      v.srcObject = props.stream
    }
  },
  { flush: 'post' },
)

defineExpose({
  selectedCount: computed(() => layerRef.value?.selectedCount ?? 0),
  deleteSelection: () => layerRef.value?.deleteSelection(),
})
</script>

<template>
  <div ref="rootEl" class="screen-tile">
    <video
      ref="videoEl"
      autoplay
      playsinline
      :muted="muted ?? true"
      @loadedmetadata="onVideoMeta"
      @resize="onVideoMeta"
    />
    <DrawLayer
      v-if="content.width > 0"
      ref="layerRef"
      class="overlay"
      :style="{ left: `${content.left}px`, top: `${content.top}px` }"
      :board="board"
      :tool="tool"
      :color="color"
      :size="size"
      :polyline-arrow="polylineArrow"
      :width="content.width"
      :height="content.height"
    />
  </div>
</template>

<style scoped>
.screen-tile {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.screen-tile video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.overlay {
  position: absolute;
  z-index: 2;
}
</style>
