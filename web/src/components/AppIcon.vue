<script setup lang="ts">
// pphub 自绘图标集：24×24 网格、圆角几何 + 节点/连线母题（呼应「点对点」
// 品牌形态），线宽 1.75 偏细，与常见 Feather 线性图标区分开。
// 用 v-html 注入 path，不引图标库依赖。
const ICONS: Record<string, string> = {
  // 连接：两个节点 + 中间的直连链路
  hub: '<circle cx="5.5" cy="12" r="2.5"/><circle cx="18.5" cy="12" r="2.5"/><path d="M8 12h8"/><path d="M8.6 8.2a7 7 0 0 1 6.8 0"/><path d="M8.6 15.8a7 7 0 0 0 6.8 0"/>',
  // 发送：托盘 + 上行
  upload:
    '<path d="M12 15.5V4.5"/><path d="M8.3 8.2 12 4.5l3.7 3.7"/><path d="M4.5 14v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14"/>',
  download:
    '<path d="M12 4.5v11"/><path d="M8.3 11.8 12 15.5l3.7-3.7"/><path d="M4.5 14v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14"/>',
  // 消息：圆角方泡 + 尾巴
  chat: '<path d="M4.5 7a2.5 2.5 0 0 1 2.5-2.5h10A2.5 2.5 0 0 1 19.5 7v6a2.5 2.5 0 0 1-2.5 2.5H9.8L5.6 19v-3.6A2.5 2.5 0 0 1 4.5 13z"/><path d="M8.6 9.2h6.8"/><path d="M8.6 12h4.4"/>',
  clipboard:
    '<path d="M9 5.5H7.4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9.2a2 2 0 0 0 2-2v-10a2 2 0 0 0-2-2H15"/><rect x="9" y="3.6" width="6" height="3.6" rx="1.4"/><path d="M8.8 12h6.4"/><path d="M8.8 15h4"/>',
  monitor:
    '<rect x="3.2" y="4.8" width="17.6" height="11.4" rx="2.4"/><path d="M9 19.5h6"/><path d="M12 16.2v3.3"/>',
  pen: '<path d="M4.5 19.5l1-3.4L15.4 6.2a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.9 19.5z"/><path d="M14.4 7.2l3 3"/>',
  play: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="3"/><path d="M10.4 9.6l4.6 2.6-4.6 2.6z"/>',
  link: '<path d="M10.4 13.6a3.4 3.4 0 0 0 4.8 0l2.6-2.6a3.4 3.4 0 0 0-4.8-4.8l-1.3 1.3"/><path d="M13.6 10.4a3.4 3.4 0 0 0-4.8 0l-2.6 2.6a3.4 3.4 0 0 0 4.8 4.8l1.3-1.3"/>',
  copy: '<rect x="9" y="9" width="10.5" height="10.5" rx="2.4"/><path d="M15 6.6a2 2 0 0 0-2-2H6.9a2.4 2.4 0 0 0-2.4 2.4V13a2 2 0 0 0 2 2"/>',
  check: '<path d="M4.8 12.8l4.4 4.2 10-10.2"/>',
  x: '<path d="M6.4 6.4l11.2 11.2"/><path d="M17.6 6.4L6.4 17.6"/>',
  'chevron-down': '<path d="M6.4 9.6l5.6 5.2 5.6-5.2"/>',
  send: '<path d="M20 4L4.6 10.2a.5.5 0 0 0 .05.94l5.6 1.6 1.6 5.6a.5.5 0 0 0 .94.05z"/><path d="M20 4l-9.75 9.75"/>',
  file: '<path d="M13.6 4.5H7.4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h9.2a2 2 0 0 0 2-2v-6.9z"/><path d="M13.6 4.5v4.1a2 2 0 0 0 2 2h3"/>',
  refresh:
    '<path d="M19.4 12a7.4 7.4 0 1 1-2.6-5.6"/><path d="M19.6 4.8v4.4h-4.4"/>',
  info: '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="5.2"/><path d="M12 11v5.2"/><path d="M12 8.1h.01"/>',
  users:
    '<circle cx="9" cy="8.4" r="3.1"/><path d="M3.8 19.4a5.4 5.4 0 0 1 10.4 0"/><path d="M15.6 5.7a3.1 3.1 0 0 1 0 5.5"/><path d="M17 14.5a5.4 5.4 0 0 1 3.2 4.9"/>',
  shield:
    '<path d="M12 3.8l6.6 2.3v5.3c0 4.2-2.9 7-6.6 8.8-3.7-1.8-6.6-4.6-6.6-8.8V6.1z"/><path d="M9.3 12.1l1.9 1.9 3.6-3.7"/>',
  cursor: '<path d="M5.4 4.4l13.4 5.9a.5.5 0 0 1-.05.94l-5.2 1.5-1.5 5.2a.5.5 0 0 1-.94.05z"/>',
  eraser:
    '<path d="M9.6 19.4h9.9"/><path d="M17.7 12.6l-6.4 6.4a2 2 0 0 1-2.8 0L5.1 15.6a2 2 0 0 1 0-2.8L11.5 6.4a2 2 0 0 1 2.8 0l3.4 3.4a2 2 0 0 1 0 2.8z"/><path d="M8.2 9.7l6.2 6.2"/>',
  undo: '<path d="M4.6 9.2h9.2a5.6 5.6 0 0 1 0 11.2"/><path d="M8.2 5.6L4.6 9.2l3.6 3.6"/>',
  trash:
    '<path d="M4.8 7.2h14.4"/><path d="M9.4 7.2V5.6a1.6 1.6 0 0 1 1.6-1.6h2a1.6 1.6 0 0 1 1.6 1.6v1.6"/><path d="M6.6 7.2l.8 11a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8l.8-11"/><path d="M10.5 11v5"/><path d="M13.5 11v5"/>',
  volume:
    '<path d="M4.6 9.6h2.8L11.8 6v12L7.4 14.4H4.6z"/><path d="M15 9.6a3.6 3.6 0 0 1 0 4.8"/><path d="M17.8 7a7.2 7.2 0 0 1 0 10"/>',
  'volume-off':
    '<path d="M4.6 9.6h2.8L11.8 6v12L7.4 14.4H4.6z"/><path d="M15.4 10.2l4 3.6"/><path d="M19.4 10.2l-4 3.6"/>',
  image:
    '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.8"/><circle cx="9" cy="9.6" r="1.6"/><path d="M4.4 17.4l4.4-4.2a1.8 1.8 0 0 1 2.5 0l4.9 4.7"/><path d="M14.4 14.6l1.5-1.4a1.8 1.8 0 0 1 2.5 0l1.8 1.7"/>',
  'stop-circle':
    '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="5.2"/><rect x="9" y="9" width="6" height="6" rx="1.6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3.2v2.2"/><path d="M12 18.6v2.2"/><path d="M3.2 12h2.2"/><path d="M18.6 12h2.2"/><path d="M5.9 5.9l1.55 1.55"/><path d="M16.55 16.55L18.1 18.1"/><path d="M18.1 5.9l-1.55 1.55"/><path d="M7.45 16.55L5.9 18.1"/>',
  moon: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z"/>',
  // 屏幕共享多画面布局
  'layout-focus': '<rect x="3.6" y="5" width="16.8" height="14" rx="2.4"/>',
  'layout-split':
    '<rect x="3.4" y="5" width="7.7" height="14" rx="2"/><rect x="12.9" y="5" width="7.7" height="14" rx="2"/>',
  'layout-grid':
    '<rect x="3.4" y="3.4" width="7.7" height="7.7" rx="2"/><rect x="12.9" y="3.4" width="7.7" height="7.7" rx="2"/><rect x="3.4" y="12.9" width="7.7" height="7.7" rx="2"/><rect x="12.9" y="12.9" width="7.7" height="7.7" rx="2"/>',
  expand:
    '<path d="M13.8 4.6h5.6v5.6"/><path d="M10.2 19.4H4.6v-5.6"/><path d="M19.4 4.6l-6.2 6.2"/><path d="M4.6 19.4l6.2-6.2"/>',
}

defineProps<{ name: string; size?: number }>()
</script>

<template>
  <svg
    :width="size ?? 20"
    :height="size ?? 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="ICONS[name] ?? ''"
  />
</template>
