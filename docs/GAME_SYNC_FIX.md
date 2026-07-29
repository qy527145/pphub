# 游戏对局 Bug 修复说明

## 修复的问题

### 1. ✅ 卡在等待对手状态

**问题原因**：
- 游戏组件没有监听 `table.state` 的变化
- 游戏开始后（`state = 'playing'`），组件不知道应该开始游戏
- `myTurn` 计算没有检查 `table.state`

**修复方案**：

在 `GomokuGame.vue` 中添加：

```typescript
// 监听桌子状态变化，游戏开始时初始化玩家
watch(() => props.table.state, (newState) => {
  if (newState === 'playing' && props.table.players.length >= 2) {
    gameState.value.players = [props.table.players[0], props.table.players[1]]
    console.log('[Gomoku] 游戏开始，玩家:', gameState.value.players)
  }
})

const myTurn = computed(() => {
  if (!myColor.value || gameState.value.winner || props.table.state !== 'playing') return false
  return gameState.value.turn === myColor.value
})
```

**效果**：
- 游戏状态变为 'playing' 时自动初始化玩家
- 只有在 'playing' 状态下才能走子
- 正确判断是否轮到自己

---

### 2. ✅ 无法正常开始游戏

**问题原因**：
- 远程玩家的走法没有被同步
- `game-move` 消息在 store 中没有被处理
- 游戏组件没有监听远程状态变化

**修复方案**：

**Step 1: Store 中存储游戏状态**

```typescript
// 游戏状态：tableId -> 游戏特定状态
const gameStates = reactive(new Map<string, any>())

case 'game-move': {
  const moveData = msg.moveData
  if (moveData && msg.tableId) {
    // 更新游戏状态
    gameStates.set(msg.tableId, moveData)
  }
  break
}
```

**Step 2: 游戏组件监听远程走法**

```typescript
// 监听远程走法
watch(() => store.gameStates.get(props.table.tableId), (remoteState) => {
  if (remoteState && remoteState.moves > gameState.value.moves) {
    console.log('[Gomoku] 收到远程走法:', remoteState)
    gameState.value = {
      ...gameState.value,
      cells: remoteState.cells || gameState.value.cells,
      turn: remoteState.turn || gameState.value.turn,
      moves: remoteState.moves || gameState.value.moves,
      lastMove: remoteState.idx,
      winLine: remoteState.winLine,
      winner: remoteState.winner,
    }
  }
}, { deep: true })
```

**效果**：
- A 走一步 → 广播 `game-move` → B 收到并更新棋盘
- B 走一步 → 广播 `game-move` → A 收到并更新棋盘
- 双方状态实时同步

---

### 3. ✅ 旁观者无法进入已满桌子

**问题原因**：
- `joinGameTable` 函数没有处理桌子已满的情况
- 当玩家位满时，阻止了所有人加入（包括旁观者）

**修复方案**：

```typescript
function joinGameTable(tableId: string, asSpectator: boolean): void {
  const table = gameTables.get(tableId)
  if (!table) return

  // 如果桌子满了但是要旁观，仍然可以加入
  const meta = getGameMeta(table.gameType)
  if (!asSpectator && meta && table.players.length >= meta.playerCount) {
    // 玩家位满了，自动改为旁观
    asSpectator = true
  }

  if (asSpectator) {
    if (!table.spectators.includes(myId.value)) {
      table.spectators.push(myId.value)
    }
  } else {
    if (!table.players.includes(myId.value)) {
      table.players.push(myId.value)
    }
  }
  
  // ... 其余逻辑
}
```

**效果**：
- 玩家位满后，仍然可以作为旁观者加入
- 如果尝试作为玩家加入已满桌子，自动转为旁观者
- 旁观者数量无限制

---

## 技术细节

### 游戏状态同步流程

```
┌─────────────────────────────────────────────────────┐
│                  玩家 A (走子)                      │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ 1. makeMove(idx)
                   │    更新本地 gameState
                   │
                   │ 2. store.sendGameMove(tableId, moveData)
                   │    广播 { kind: 'game-move', moveData }
                   │
                   ↓
┌─────────────────────────────────────────────────────┐
│              Mesh Layer (P2P)                       │
│  broadcast({ kind: 'game-move', ... })              │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ 3. 消息路由到所有节点
                   │
                   ↓
┌─────────────────────────────────────────────────────┐
│              玩家 B (接收)                          │
│  handleGame() -> case 'game-move':                  │
│    gameStates.set(tableId, moveData)                │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ 4. watch 触发
                   │    store.gameStates.get(tableId) 变化
                   │
                   ↓
┌─────────────────────────────────────────────────────┐
│          GomokuGame.vue (玩家 B)                    │
│  watch(() => store.gameStates.get(...))             │
│    更新 gameState.value                             │
│    UI 自动刷新                                       │
└─────────────────────────────────────────────────────┘
```

### 关键数据结构

**gameStates Map**：
```typescript
Map<string, any> {
  'table_abc123' => {
    idx: 112,           // 落子位置
    cells: [0,0,1,2...], // 完整棋盘
    turn: 2,            // 下一个轮次
    moves: 15,          // 已走步数
    winLine: [110,111,112,113,114], // 获胜连线
    winner: 'peer_xyz'  // 获胜者
  }
}
```

**同步机制**：
- 使用 Vue 的 `reactive()` 包装 Map
- `watch()` 监听特定 tableId 的状态
- `{ deep: true }` 确保深层变化也被监听
- 只在 `moves` 增加时更新（避免循环）

---

## UI 改进

### 状态提示

新增了清晰的状态提示：

```vue
<div v-if="gameState.winner" class="result">
  {{ gameState.winner === store.myId ? '你赢了！' : `${store.displayName(gameState.winner)} 赢了！` }}
</div>
<div v-else-if="props.table.state !== 'playing'" class="waiting">
  等待游戏开始...
</div>
<div v-else-if="myTurn" class="turn-hint">
  轮到你了
</div>
<div v-else class="turn-hint">
  等待对手...
</div>
```

**显示内容**：
1. **游戏未开始**："等待游戏开始..."
2. **轮到自己**："轮到你了"（绿色高亮）
3. **等待对手**："等待对手..."
4. **游戏结束**："你赢了！" / "XXX 赢了！"

---

## 调试日志

添加了详细的控制台日志：

```javascript
console.log('[Gomoku] 收到远程走法:', remoteState)
console.log('[Gomoku] 游戏开始，玩家:', gameState.value.players)
```

在浏览器控制台可以看到：
- 何时收到远程走法
- 走法的详细内容
- 游戏开始时的玩家列表

---

## 测试场景

### 场景 1：正常对局

1. A 创建五子棋桌子
2. B 加入桌子
3. A（桌主）点击"开始游戏"
4. **验证**：双方都看到"轮到你了" / "等待对手..."
5. A 落子
6. **验证**：B 看到 A 的棋子，轮到 B
7. B 落子
8. **验证**：A 看到 B 的棋子，轮到 A
9. 继续对局直到一方获胜

### 场景 2：旁观模式

1. A 和 B 正在对局（玩家位满）
2. C 进入游戏大厅，看到这个桌子
3. C 点击"观战"
4. **验证**：C 成功进入，看到完整棋盘
5. A 和 B 继续对局
6. **验证**：C 实时看到棋盘更新

### 场景 3：中途加入旁观

1. A 和 B 正在对局（已走 10 步）
2. C 点击"观战"加入
3. **验证**：C 看到当前的棋盘状态（前 10 步的结果）
4. A 走第 11 步
5. **验证**：C 看到第 11 步的棋子

---

## 构建状态

✅ **构建成功**
- JavaScript: 346.97 kB (gzip: 122.63 kB)
- CSS: 78.63 kB (gzip: 13.24 kB)

---

## 待优化功能

### 1. 状态恢复

**问题**：中途加入的旁观者只能看到之后的走法，看不到之前的棋盘。

**解决方案**：
```typescript
// 在 peer-channel-open 时同步完整游戏状态
m.on('peer-channel-open', (peerId) => {
  // 同步游戏桌
  // ...
  
  // 同步游戏状态
  for (const [tableId, state] of gameStates) {
    m.sendTo(peerId, {
      kind: 'game-state-sync',
      tableId,
      state,
    })
  }
})
```

### 2. 断线重连

**问题**：玩家断线后重新连接，游戏状态丢失。

**解决方案**：
- 在 `table.config` 中保存完整游戏状态
- 重连后从 `table.config` 恢复

### 3. 悔棋功能

**实现**：
- 添加"请求悔棋"按钮
- 对手同意后回退 2 步
- 更新 `gameState` 和广播

### 4. 超时机制

**实现**：
- 每步限时 60 秒
- 超时自动判负
- 显示倒计时

---

## 总结

本次修复解决了 3 个关键问题：

1. ✅ **卡在等待对手**：添加 `table.state` 监听，正确判断游戏状态
2. ✅ **无法正常开始**：实现完整的游戏状态同步机制
3. ✅ **旁观受阻**：允许桌子满后继续加入旁观者

现在游戏对局功能应该可以正常工作了！🎮✨
