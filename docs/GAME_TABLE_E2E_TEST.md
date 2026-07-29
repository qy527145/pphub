# 游戏桌端到端测试指南

## 测试目的

验证游戏桌的创建、同步和显示功能是否正常工作。

## 测试环境准备

1. 启动 pphub 后端：
   ```bash
   cd /Users/xuqiao/pphub
   cargo run
   ```

2. 打开浏览器控制台，确保能看到日志输出

## 测试场景 1：基本创建和同步

### 步骤

1. **打开两个浏览器标签**（A 和 B）
   - 标签 A：`http://localhost:8848`
   - 标签 B：`http://localhost:8848`

2. **标签 A：建立连接**
   - 点击"开启监听"
   - 记下短码（例如：`abc123`）
   - 打开控制台，查看日志

3. **标签 B：加入网络**
   - 输入 A 的短码
   - 点击"加入"
   - 等待连接成功

4. **标签 A：创建游戏桌**
   - 点击侧边栏"🎮 游戏大厅"
   - 点击"创建游戏桌"
   - 选择"五子棋"
   - 选择"公开桌子"
   - 点击"创建"

5. **检查标签 A 的控制台**
   应该看到类似：
   ```
   [GameTable] 创建游戏桌: {
     tableId: "table_xxxx",
     gameType: "gomoku",
     visibility: "public",
     players: ["peer_A_id"],
     mesh: true,
     peerCount: 1
   }
   [GameTable] 已广播 table-create 消息到 1 个节点
   ```

6. **检查标签 B 的控制台**
   应该看到：
   ```
   [GameTable] 收到 table-create: {
     from: "peer_A_id",
     tableId: "table_xxxx",
     gameType: "gomoku",
     visibility: "public",
     players: ["peer_A_id"]
   }
   [GameTable] 已添加到 gameTables, 当前桌子数: 1
   ```

7. **检查标签 B 的 UI**
   - 切换到"🎮 游戏大厅"
   - 应该能看到 A 创建的游戏桌卡片
   - 卡片显示：五子棋、等待中、1/2 玩家

### 预期结果

✅ A 创建桌子后，B 立即看到  
✅ 控制台日志显示消息已发送和接收  
✅ B 可以点击"加入游戏桌"

---

## 测试场景 2：后加入者看到现有桌子

### 步骤

1. **延续场景 1**（A 已创建桌子，B 已在线）

2. **打开第三个标签 C**
   - 访问 `http://localhost:8848`
   - 输入 A 的短码加入

3. **等待 C 连接成功**

4. **检查 A 的控制台**
   应该看到：
   ```
   [GameTable] peer-channel-open: peer_C_id 当前桌子数: 1
   [GameTable] 已同步 1 个公开桌子给 peer_C_id
   ```

5. **检查 C 的控制台**
   应该看到：
   ```
   [GameTable] 收到 table-create: {
     from: "peer_A_id",
     tableId: "table_xxxx",
     gameType: "gomoku",
     visibility: "public",
     players: ["peer_A_id"]
   }
   [GameTable] 已添加到 gameTables, 当前桌子数: 1
   ```

6. **检查 C 的 UI**
   - 切换到"🎮 游戏大厅"
   - 应该能看到 A 创建的游戏桌

### 预期结果

✅ C 加入后立即同步到现有桌子  
✅ peer-channel-open 时触发同步  
✅ C 可以加入 A 创建的桌子

---

## 测试场景 3：多个桌子同时存在

### 步骤

1. **标签 A：创建第一个桌子**（五子棋）
2. **标签 B：创建第二个桌子**（象棋）
3. **打开新标签 D**，加入网络

4. **检查 D 的控制台**
   应该看到**两次** table-create：
   ```
   [GameTable] 收到 table-create: { gameType: "gomoku", ... }
   [GameTable] 收到 table-create: { gameType: "xiangqi", ... }
   [GameTable] 已添加到 gameTables, 当前桌子数: 2
   ```

5. **检查 D 的游戏大厅**
   应该看到两个游戏桌卡片

### 预期结果

✅ D 能看到所有公开桌子  
✅ 游戏大厅显示 2 个桌子  
✅ 可以加入任意一个

---

## 测试场景 4：私密桌子不可见

### 步骤

1. **标签 A：创建私密桌子**
   - 点击"创建游戏桌"
   - 选择"私密桌子"
   - 创建

2. **检查标签 B 的游戏大厅**
   - 应该**看不到** A 创建的私密桌子

3. **检查 A 的控制台**
   - 广播消息应该正常发送

4. **检查 B 的控制台**
   - 应该**收到** table-create 消息
   - 但因为 visibility 是 'private'，不应该显示在大厅

### 预期结果

✅ 私密桌子不在大厅显示  
✅ 消息仍然被接收（只是不显示）  
✅ 只有被邀请的人能看到

---

## 调试技巧

### 1. 检查 mesh 状态
在浏览器控制台输入：
```javascript
// 检查当前连接的对等节点
store.connectedPeers

// 检查游戏桌数量
store.gameTables.size

// 查看所有游戏桌
Array.from(store.gameTables.values())
```

### 2. 手动触发同步
如果怀疑同步失败，在控制台手动触发：
```javascript
// 在有桌子的标签（如 A）中执行
for (const table of store.gameTables.values()) {
  console.log('桌子:', table.tableId, table.gameType, table.visibility)
}
```

### 3. 检查消息是否发送
在 `createGameTable` 的控制台日志中：
- `mesh: true` 表示 mesh 已初始化
- `peerCount: N` 表示有 N 个连接的节点
- 如果 `peerCount: 0`，说明还没有其他节点连接

### 4. 检查消息是否接收
在 `handleGame` 的 table-create 分支中：
- 如果看到 `收到 table-create` 日志，说明消息已接收
- 如果 `gameTables.size` 增加，说明已添加成功
- 如果 UI 不显示，可能是组件刷新问题

---

## 常见问题排查

### 问题 1：B 看不到 A 的桌子

**检查点**：
1. A 的控制台是否显示"已广播 table-create"？
2. A 的 peerCount 是否 > 0？
3. B 的控制台是否收到 table-create 消息？
4. B 的 `gameTables.size` 是否增加？

**可能原因**：
- Mesh 未初始化（A 没有开启监听或 B 没有连接）
- 消息被过滤（但不应该，因为我们添加了路由）
- Vue 响应式问题（gameTables 不是 reactive）

### 问题 2：C（后加入）看不到现有桌子

**检查点**：
1. A 的控制台是否显示 "peer-channel-open: C"？
2. A 是否显示"已同步 N 个公开桌子"？
3. C 的控制台是否收到 table-create？

**可能原因**：
- peer-channel-open 事件未触发
- 同步逻辑中的 visibility 判断问题
- sendTo 失败（通道未就绪）

### 问题 3：桌子偶尔消失

**检查点**：
1. 是否有人离开了桌子？
2. 桌子是否被清理了？
3. 路由切换导致状态重置？

**可能原因**：
- gameTables 被意外清空
- 组件卸载时的副作用
- 某个操作触发了桌子删除逻辑

---

## 成功标准

- ✅ 所有测试场景通过
- ✅ 控制台日志显示正确的消息流
- ✅ UI 实时更新，无需刷新
- ✅ 后加入者能看到现有桌子
- ✅ 私密桌子正确过滤

如果某个测试失败，请记录：
1. 失败的测试场景编号
2. 控制台的完整日志
3. 网络面板中的 WebSocket 消息（如果需要）
4. 执行的操作序列

这些信息将帮助定位问题的根本原因。
