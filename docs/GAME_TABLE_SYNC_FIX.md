# 游戏桌消息同步修复说明

## 问题描述

游戏桌功能存在严重的消息同步问题：
1. **创建桌子后别人看不到**：即使是公开的桌子，其他用户也无法看到
2. **邀请无法送达**：邀请对方时对方收不到消息
3. **状态不同步**：坐下/站起等操作其他人看不到

## 根本原因

游戏桌消息虽然定义了（在 `ControlMessage` 中），但缺少了关键的消息路由和处理逻辑：

1. **Mesh 层未路由**：`handleControl` 函数中没有处理游戏桌消息类型
2. **Store 层未处理**：`handleGame` 函数中没有处理游戏桌消息
3. **类型定义不完整**：`GameMessage` 类型不包含游戏桌消息

## 修复方案

### 1. 更新 GameMessage 类型定义

**文件：`core/mesh.ts`**

```typescript
// 修复前
export type GameMessage = Extract<
  ControlMessage,
  { kind: `guess-${string}` } | { kind: `gomoku-${string}` }
>

// 修复后
export type GameMessage = Extract<
  ControlMessage,
  | { kind: `guess-${string}` }
  | { kind: `gomoku-${string}` }
  | { kind: `table-${string}` }      // 游戏桌消息
  | { kind: `game-${string}` }       // 游戏动作消息
  | { kind: 'mouse-pos' }            // 鼠标位置消息
>
```

### 2. 在 Mesh 层添加消息路由

**文件：`core/mesh.ts` - handleControl 函数**

在 `gomoku-resign` 后添加所有游戏桌消息类型：

```typescript
case 'gomoku-resign':
case 'table-create':      // 创建游戏桌
case 'table-join':        // 加入游戏桌
case 'table-spectate':    // 旁观游戏桌
case 'table-leave':       // 离开游戏桌
case 'table-start':       // 开始游戏
case 'table-sit':         // 坐下
case 'table-standup':     // 站起
case 'table-invite':      // 邀请
case 'game-move':         // 游戏动作
case 'game-chat':         // 游戏聊天
case 'mouse-pos':         // 鼠标位置
  this.emit('game', { from, msg })
  break
```

### 3. 在 Store 层添加消息处理

**文件：`stores/room.ts` - handleGame 函数**

添加完整的游戏桌消息处理逻辑：

```typescript
case 'table-create': {
  const table = msg.table as GameTable
  if (table && table.tableId) {
    gameTables.set(table.tableId, table)
  }
  break
}

case 'table-join': {
  const table = gameTables.get(msg.tableId)
  if (table && !table.players.includes(from)) {
    table.players.push(from)
  }
  break
}

case 'table-spectate': {
  const table = gameTables.get(msg.tableId)
  if (table && !table.spectators.includes(from)) {
    table.spectators.push(from)
  }
  break
}

case 'table-leave': {
  const table = gameTables.get(msg.tableId)
  if (table) {
    table.players = table.players.filter(p => p !== from)
    table.spectators = table.spectators.filter(p => p !== from)
    // 桌主转移逻辑
    if (table.hostId === from && table.players.length > 0) {
      table.hostId = table.players[0]
    }
    // 桌子空了删除
    if (table.players.length === 0 && table.spectators.length === 0) {
      gameTables.delete(msg.tableId)
    }
  }
  break
}

case 'table-start': {
  const table = gameTables.get(msg.tableId)
  if (table) {
    table.state = 'playing'
    table.startedAt = Date.now()
  }
  break
}

case 'table-sit': {
  const table = gameTables.get(msg.tableId)
  if (table) {
    table.spectators = table.spectators.filter(p => p !== from)
    if (!table.players.includes(from)) {
      table.players.push(from)
    }
  }
  break
}

case 'table-standup': {
  const table = gameTables.get(msg.tableId)
  if (table) {
    table.players = table.players.filter(p => p !== from)
    if (!table.spectators.includes(from)) {
      table.spectators.push(from)
    }
  }
  break
}

case 'table-invite': {
  // 收到邀请通知
  notifyBackground('游戏邀请', `${displayName(from)} 邀请你加入 ${msg.gameName}`)
  lastError.value = `${displayName(from)} 邀请你加入游戏桌`
  break
}

case 'game-chat': {
  const chatMsg = msg.chatMsg as GameChatMessage
  if (chatMsg && msg.tableId) {
    const chats = gameChats.get(msg.tableId) || []
    chats.push(chatMsg)
    gameChats.set(msg.tableId, chats)
  }
  break
}

case 'mouse-pos': {
  const pos = msg.pos as MousePosition
  if (pos && msg.tableId) {
    const positions = gameMousePositions.get(msg.tableId) || []
    // 只保留最近的位置
    const filtered = positions.filter(p => 
      p.peerId !== pos.peerId || Date.now() - p.ts < 5000
    )
    filtered.push(pos)
    gameMousePositions.set(msg.tableId, filtered)
  }
  break
}
```

## 消息流程

### 创建游戏桌流程

1. **用户 A 创建桌子**：
   ```
   UI → store.createGameTable() 
   → mesh.broadcast({ kind: 'table-create', table })
   → 发送到所有在线节点
   ```

2. **用户 B 接收**：
   ```
   接收消息 → mesh.handleControl()
   → emit('game', { from: A, msg })
   → store.handleGame()
   → gameTables.set(tableId, table)
   → UI 自动刷新显示新桌子
   ```

### 加入游戏桌流程

1. **用户 B 点击加入**：
   ```
   UI → store.joinGameTable(tableId)
   → 本地更新：table.players.push(myId)
   → mesh.broadcast({ kind: 'table-join', tableId })
   ```

2. **用户 A 接收**：
   ```
   接收消息 → mesh.handleControl()
   → emit('game', { from: B, msg })
   → store.handleGame()
   → table.players.push(B)
   → UI 显示 B 加入了
   ```

### 邀请流程

1. **用户 A 邀请 B**：
   ```
   UI → store.inviteToTable(tableId, B)
   → mesh.sendTo(B, { kind: 'table-invite', gameName })
   ```

2. **用户 B 接收**：
   ```
   接收消息 → mesh.handleControl()
   → emit('game', { from: A, msg })
   → store.handleGame()
   → notifyBackground() 显示通知
   → lastError.value 显示提示
   ```

## Vue 响应式同步

由于使用了 Vue 的响应式系统：

```typescript
const gameTables = reactive(new Map<string, GameTable>())
```

所以当：
- `gameTables.set()` - 自动触发 UI 更新
- `table.players.push()` - 自动触发 UI 更新
- `table.state = 'playing'` - 自动触发 UI 更新

UI 会实时同步显示所有状态变化。

## 测试验证

### 测试场景 1：创建和加入

1. 打开两个浏览器标签（A 和 B）
2. 都进入游戏大厅
3. A 创建公开桌子
4. **预期**：B 的游戏大厅立即显示 A 创建的桌子
5. B 点击"加入游戏桌"
6. **预期**：A 看到 B 加入了

### 测试场景 2：坐下和站起

1. B 加入后默认是旁观者
2. B 点击"坐下参与游戏"
3. **预期**：A 看到 B 从旁观者移到玩家列表
4. B 点击"站起旁观"
5. **预期**：A 看到 B 从玩家移到旁观者列表

### 测试场景 3：邀请

1. A 在游戏桌内点击"邀请好友"
2. 选择 B，点击"邀请"
3. **预期**：B 收到系统通知"XXX 邀请你加入游戏桌"

### 测试场景 4：开始游戏

1. A 和 B 都坐下（玩家满）
2. A（桌主）点击"开始游戏"
3. **预期**：
   - 双方都看到状态变为"游戏中"
   - 游戏界面显示游戏画面
   - 不再能坐下/站起

## 构建状态

✅ **构建成功**
- JavaScript: 342.61 kB (gzip: 121.27 kB)
- CSS: 75.40 kB (gzip: 12.76 kB)

## 总结

这次修复完成了游戏桌系统的核心消息同步机制：

1. ✅ 类型定义完整
2. ✅ 消息路由正确
3. ✅ 状态同步实时
4. ✅ UI 响应式更新

现在游戏桌系统应该可以正常工作了！多人游戏的基础设施已经完备。🎮✨
