<script setup lang="ts">
// 绘制工具栏：工具/颜色/粗细选择 + 撤销/清空，屏幕批注与白板共用。
// 通过 v-model:tool / v-model:color / v-model:size 与父组件同步。

import { PEN_COLORS, PEN_SIZES } from '@/core/draw'
import type { DrawMode } from '@/core/messages'
import AppIcon from './AppIcon.vue'

defineProps<{
  tool: 'pointer' | DrawMode
  color: string
  size: number
  /** pointer 工具的名称（屏幕共享叫“远程指针”，白板可不展示）。 */
  pointerLabel?: string
}>()

const emit = defineEmits<{
  'update:tool': [tool: 'pointer' | DrawMode]
  'update:color': [color: string]
  'update:size': [size: number]
  undo: []
  clear: []
}>()
</script>

<template>
  <div class="toolbar">
    <button
      v-if="pointerLabel"
      class="tool"
      :class="{ on: tool === 'pointer' }"
      :title="pointerLabel"
      @click="emit('update:tool', 'pointer')"
    >
      <AppIcon name="cursor" :size="16" />
    </button>
    <button
      class="tool"
      :class="{ on: tool === 'pen' }"
      title="画笔"
      @click="emit('update:tool', 'pen')"
    >
      <AppIcon name="pen" :size="16" />
    </button>
    <button
      class="tool"
      :class="{ on: tool === 'eraser' }"
      title="橡皮"
      @click="emit('update:tool', 'eraser')"
    >
      <AppIcon name="eraser" :size="16" />
    </button>

    <span class="sep" />

    <button
      v-for="c in PEN_COLORS"
      :key="c"
      class="swatch"
      :class="{ on: color === c && tool !== 'eraser' }"
      :style="{ background: c }"
      :title="`颜色 ${c}`"
      @click="emit('update:color', c); tool === 'eraser' && emit('update:tool', 'pen')"
    />

    <span class="sep" />

    <button
      v-for="s in PEN_SIZES"
      :key="s"
      class="tool sizebtn"
      :class="{ on: size === s }"
      :title="`粗细 ${s}`"
      @click="emit('update:size', s)"
    >
      <span class="dot" :style="{ width: `${4 + s}px`, height: `${4 + s}px` }" />
    </button>

    <span class="sep" />

    <button class="tool" title="撤销我的上一笔" @click="emit('undo')">
      <AppIcon name="undo" :size="16" />
    </button>
    <button class="tool" title="清空（对所有人生效）" @click="emit('clear')">
      <AppIcon name="trash" :size="16" />
    </button>

    <slot />
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  flex-wrap: wrap;
}

.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 7px;
  color: var(--text);
}

.tool:hover:not(:disabled) {
  background: var(--panel-2);
  border-color: transparent;
  color: var(--accent);
}

.tool.on {
  background: var(--accent-active);
  color: var(--accent-strong);
}

.swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 2px solid transparent;
  flex: none;
}

.swatch.on {
  border-color: var(--accent-strong);
  box-shadow: 0 0 0 2px var(--panel) inset;
}

.sizebtn .dot {
  display: block;
  border-radius: 50%;
  background: currentColor;
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
  flex: none;
}
</style>
