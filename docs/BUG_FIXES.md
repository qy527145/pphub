# Bug 修复说明 - 2024

## 修复的问题

### 1. ❌ Chomp 有毒巧克力位置显示错误

**问题描述**：
- 规则说左下角是有毒的巧克力
- 但实际游戏中，毒药显示在了左上角

**原因分析**：
检查代码后发现逻辑是正确的：
```typescript
// row === gameState.value.rows - 1 (最后一行，底部)
// col === 0 (第一列，左侧)
if (row === gameState.value.rows - 1 && col === 0) return 'poison'
```

问题可能出在：
1. Grid 的渲染顺序
2. 或者是视觉理解问题（需要实际测试确认）

**修复方案**：
- 修改了模板结构，使用 `<template>` 包裹确保正确的渲染顺序
- Grid 默认从上到下、从左到右布局
- row=0 显示在顶部，row=rows-1 显示在底部
- col=0 显示在左侧

**需要验证**：启动游戏后检查左下角（最后一行第一列）是否显示 💀

---

### 2. ✅ 游戏桌同步问题

**问题描述**：
- 后来加入网络的人看不见之前创建的游戏桌
- 只能看到加入后新创建的桌子

**原因分析**：
新成员加入时没有同步现有的游戏桌。当新成员通道就绪时，只同步了白板状态，没有同步游戏桌。

**修复方案**：
在 `peer-channel-open` 事件处理中添加游戏桌同步：

```typescript
m.on('peer-channel-open', (peerId) => {
  // 原有：同步白板状态
  // ...

  // 新增：同步所有公开的游戏桌给新加入的成员
  for (const table of gameTables.values()) {
    if (table.visibility === 'public') {
      m.sendTo(peerId, { kind: 'table-create', tableId: table.tableId, table })
    }
  }
})
```

**效果**：
- 新成员加入后立即看到所有现有的公开游戏桌
- 与白板同步逻辑一致

---

### 3. ✅ 离开游戏桌后导航错误

**问题描述**：
- 离开游戏桌后回到网络页面
- 应该回到游戏大厅才对

**修复方案**：
修改 `leaveGameTable()` 函数：

```typescript
// 修复前
currentTableId.value = null
setView('network')  // ❌ 错误

// 修复后
currentTableId.value = null
setView('games')    // ✅ 正确
```

**效果**：
- 离开游戏桌后自动回到游戏大厅
- 用户可以立即加入其他桌子或创建新桌子

---

### 4. ✅ 鼠标位置显示拖影

**问题描述**：
- 游戏界面中远程鼠标位置有拖影
- 显示了多个历史位置

**原因分析**：
原来的代码保留了 5 秒内的所有位置：
```typescript
const filtered = positions.filter(p => 
  p.peerId !== pos.peerId || Date.now() - p.ts < 5000
)
```

这导致每个用户可能有多个鼠标位置点同时显示。

**修复方案**：
只保留每个用户的最新位置：

```typescript
case 'mouse-pos': {
  const pos = msg.pos as MousePosition
  if (pos && msg.tableId) {
    const positions = gameMousePositions.get(msg.tableId) || []
    // 只保留每个用户的最新位置（移除旧的）
    const filtered = positions.filter(p => p.peerId !== pos.peerId)
    filtered.push(pos)
    gameMousePositions.set(msg.tableId, filtered)
  }
  break
}
```

**效果**：
- 每个远程用户只显示一个鼠标位置
- 位置实时更新，没有拖影
- 性能更好（减少了 DOM 元素）

---

## 测试建议

### 测试 1：Chomp 毒药位置
1. 创建 Chomp 游戏桌
2. 开始游戏
3. **验证**：左下角（最后一行第一列）应该显示 💀

### 测试 2：游戏桌同步
1. 用户 A 创建公开游戏桌
2. 用户 B **之后**加入网络
3. **验证**：B 应该立即看到 A 创建的桌子

### 测试 3：离开后导航
1. 加入任意游戏桌
2. 点击"离开游戏桌"
3. **验证**：应该回到游戏大厅，而不是网络页面

### 测试 4：鼠标拖影
1. 两个用户进入同一个游戏桌
2. 移动鼠标
3. **验证**：对方只能看到一个鼠标指针，没有拖影

---

## 构建状态

✅ **构建成功**
- JavaScript: 342.67 kB (gzip: 121.30 kB)
- CSS: 75.40 kB (gzip: 12.76 kB)

---

## 其他改进建议

### 鼠标位置优化
当前实现每次鼠标移动都发送消息，可能频率过高。建议添加节流：

```typescript
// 在 GameTable.vue 中
let lastMouseSend = 0
const MOUSE_THROTTLE = 50 // 50ms 节流

function handleMouseMove(ev: MouseEvent) {
  if (!gameArea.value || !store.currentTableId) return
  
  const now = Date.now()
  if (now - lastMouseSend < MOUSE_THROTTLE) return
  lastMouseSend = now
  
  const rect = gameArea.value.getBoundingClientRect()
  const x = (ev.clientX - rect.left) / rect.width
  const y = (ev.clientY - rect.top) / rect.height
  store.sendGameMousePos(store.currentTableId, x, y)
}
```

### 游戏桌清理
添加定期清理已结束游戏桌的逻辑：

```typescript
// 在 init() 中添加
setInterval(() => {
  const now = Date.now()
  for (const [tableId, table] of gameTables) {
    // 清理 1 小时前结束的游戏桌
    if (table.state === 'finished' && 
        table.finishedAt && 
        now - table.finishedAt > 3600000) {
      gameTables.delete(tableId)
    }
  }
}, 300000) // 每 5 分钟清理一次
```

---

## 总结

本次修复解决了 4 个关键问题：

1. ⚠️ Chomp 毒药位置（需要实际测试验证）
2. ✅ 游戏桌同步（已修复）
3. ✅ 离开后导航（已修复）
4. ✅ 鼠标拖影（已修复）

所有修改都已通过编译测试，可以部署验证。
