<script setup lang="ts">
// 绘制工具栏：工具/颜色/粗细选择 + 撤销/清空，屏幕批注与白板共用。
// 通过 v-model:tool / v-model:color / v-model:size 与父组件同步。

import { PEN_COLORS, PEN_SIZES, ERASER_SIZES, TEXT_SIZES } from '@/core/draw'
import type { DrawMode } from '@/core/messages'
import AppIcon from './AppIcon.vue'

defineProps<{
  tool: 'pointer' | DrawMode
  color: string
  size: number
  /** pointer 工具的名称（屏幕共享叫“远程指针”，白板可不展示）。 */
  pointerLabel?: string
  /** 折线是否带末端箭头。 */
  polylineArrow?: boolean
  /** 当前框选命中的元素数，>0 时显示删除按钮。 */
  selectedCount?: number
}>()

const emit = defineEmits<{
  'update:tool': [tool: 'pointer' | DrawMode]
  'update:color': [color: string]
  'update:size': [size: number]
  'update:polylineArrow': [on: boolean]
  undo: []
  clear: []
  deleteSelection: []
}>()

// 根据工具类型获取可用的尺寸列表
function getSizes(tool: 'pointer' | DrawMode): number[] {
  if (tool === 'eraser') return ERASER_SIZES
  if (tool === 'text') return TEXT_SIZES
  return PEN_SIZES
}

/** pointer / select / image 不吃颜色与粗细，隐藏对应控件减少干扰。 */
function hasStyleControls(tool: 'pointer' | DrawMode): boolean {
  return tool !== 'pointer' && tool !== 'select' && tool !== 'image'
}
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
      :class="{ on: tool === 'select' }"
      title="框选（拖拽选中，Delete 删除）"
      @click="emit('update:tool', 'select')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <rect
          x="2.5"
          y="2.5"
          width="11"
          height="11"
          stroke-width="1.6"
          stroke-dasharray="3 2"
          rx="1"
        />
      </svg>
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
    <button
      class="tool"
      :class="{ on: tool === 'line' }"
      title="直线"
      @click="emit('update:tool', 'line')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <line x1="2" y1="14" x2="14" y2="2" stroke-width="2" stroke-linecap="round" />
      </svg>
    </button>
    <button
      class="tool"
      :class="{ on: tool === 'arrow' }"
      title="箭头"
      @click="emit('update:tool', 'arrow')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <line x1="2" y1="14" x2="14" y2="2" stroke-width="2" stroke-linecap="round" />
        <polyline points="9,2 14,2 14,7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <button
      class="tool"
      :class="{ on: tool === 'polyline' }"
      title="折线（点击落点，双击或回车结束）"
      @click="emit('update:tool', 'polyline')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <polyline
          points="2,13 6,6 10,10 14,3"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <button
      v-if="tool === 'polyline'"
      class="tool"
      :class="{ on: polylineArrow }"
      title="折线末端箭头"
      @click="emit('update:polylineArrow', !polylineArrow)"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <line x1="2" y1="8" x2="12" y2="8" stroke-width="2" stroke-linecap="round" />
        <polyline
          points="9,4 13,8 9,12"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <button
      class="tool"
      :class="{ on: tool === 'text' }"
      title="文本"
      @click="emit('update:tool', 'text')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M3 2h10v2H9v10H7V4H3V2z" />
      </svg>
    </button>
    <button
      class="tool"
      :class="{ on: tool === 'image' }"
      title="贴图"
      @click="emit('update:tool', 'image')"
    >
      <AppIcon name="image" :size="16" />
    </button>

    <template v-if="hasStyleControls(tool)">
      <span class="sep" />

      <template v-if="tool !== 'eraser'">
        <button
          v-for="c in PEN_COLORS"
          :key="c"
          class="swatch"
          :class="{ on: color === c }"
          :style="{ background: c }"
          :title="`颜色 ${c}`"
          @click="emit('update:color', c)"
        />

        <span class="sep" />
      </template>

      <button
        v-for="s in getSizes(tool)"
        :key="s"
        class="tool sizebtn"
        :class="{ on: size === s }"
        :title="tool === 'eraser' ? `橡皮直径 ${s}` : `粗细 ${s}`"
        @click="emit('update:size', s)"
      >
        <span
          class="dot"
          :class="{ hollow: tool === 'eraser' }"
          :style="{ width: `${Math.min(4 + s / 3, 20)}px`, height: `${Math.min(4 + s / 3, 20)}px` }"
        />
      </button>
    </template>

    <span class="sep" />

    <button
      v-if="selectedCount"
      class="tool danger"
      :title="`删除选中的 ${selectedCount} 个元素`"
      @click="emit('deleteSelection')"
    >
      <AppIcon name="trash" :size="16" />
      <span class="badge">{{ selectedCount }}</span>
    </button>
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

/* 橡皮尺寸用空心圆，和实心的画笔粗细区分开。 */
.sizebtn .dot.hollow {
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  background: transparent;
}

.tool.danger {
  position: relative;
  color: var(--danger, #e5484d);
}

.tool.danger .badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 13px;
  padding: 0 2px;
  border-radius: 7px;
  background: var(--danger, #e5484d);
  color: #fff;
  font-size: 9px;
  line-height: 13px;
  text-align: center;
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
  flex: none;
}
</style>
