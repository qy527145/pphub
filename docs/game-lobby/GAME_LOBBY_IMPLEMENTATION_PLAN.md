# 游戏大厅实施计划

## 总览

本文档提供了游戏大厅改进的分阶段实施计划，将复杂的改造工作拆解为可管理的小步骤。

## 阶段划分

### 🔴 阶段 1：核心桌号系统（1-2天）

**目标**：让用户能够通过桌号快速加入游戏

#### 1.1 集成 TableManager
- [x] 创建 `table-manager.ts` 核心模块
- [ ] 在 `room.ts` store 中集成 TableManager
- [ ] 修改 `createGameTable` 使用 TableManager 生成桌号
- [ ] 添加 `tableNumber` 字段到 GameTable 接口
- [ ] 修改网络消息，广播时包含桌号

**代码位置**：
- `web/src/core/table-manager.ts` ✅ 已创建
- `web/src/stores/room.ts` - 需要修改
- `web/src/core/games.ts` - 需要扩展 GameTable 接口

#### 1.2 快速加入功能
- [ ] 添加"输入桌号加入"按钮到游戏大厅头部
- [ ] 创建桌号输入对话框组件 `TableJoinDialog.vue`
- [ ] 实现 `joinTableByNumber(tableNumber: string)` 方法
- [ ] 处理桌号不存在的错误提示
- [ ] 显示桌号在桌子列表和桌子内视图

**UI 参考**：
```vue
<!-- GameLobby.vue 头部 -->
<header class="lobby-header">
  <h2>🎮 游戏大厅</h2>
  <div class="header-actions">
    <button @click="showJoinDialog = true">
      <AppIcon name="hash" />
      输入桌号
    </button>
    <button @click="showCreateDialog = true">
      <AppIcon name="plus" />
      创建游戏桌
    </button>
  </div>
</header>
```

#### 1.3 显示桌号
- [ ] 在游戏桌卡片上显示桌号（如 `#1234`）
- [ ] 在游戏桌内视图头部显示桌号
- [ ] 桌号点击复制到剪贴板

**测试要点**：
- ✅ 创建桌子后生成唯一桌号
- ✅ 输入桌号能成功加入
- ✅ 桌号碰撞时自动重试
- ✅ 桌子销毁后桌号延迟回收

---

### 🟠 阶段 2：密码保护桌（1天）

**目标**：支持创建私密桌，需要密码才能加入

#### 2.1 创建桌子时设置密码
- [ ] 在创建对话框添加"设置密码"选项
- [ ] 密码输入框（切换显示/隐藏）
- [ ] 密码强度提示（可选）
- [ ] 存储密码哈希到 TableManager

**UI 参考**：
```vue
<div class="form-group">
  <label>
    <input type="checkbox" v-model="usePassword" />
    设置密码保护
  </label>
  <input
    v-if="usePassword"
    v-model="password"
    type="password"
    placeholder="输入密码（4-16位）"
  />
</div>
```

#### 2.2 加入时验证密码
- [ ] 桌号输入对话框添加密码字段
- [ ] 调用 `TableManager.verifyPassword()` 验证
- [ ] 密码错误提示（3次后锁定5分钟）
- [ ] 加密桌在列表显示🔒图标

#### 2.3 邀请链接跳过密码
- [ ] 邀请者通过 InviteManager 生成带令牌的链接
- [ ] 被邀请者通过令牌直接加入（无需密码）
- [ ] 令牌5分钟过期

**测试要点**：
- ✅ 创建加密桌后密码验证有效
- ✅ 密码错误时拒绝加入
- ✅ 邀请链接可跳过密码验证
- ✅ 密码哈希不会明文传输

---

### 🟡 阶段 3：快速匹配（1-2天）

**目标**：点击"快速开始"自动匹配或创建桌子

#### 3.1 集成 MatchMaker
- [x] 创建 `match-maker.ts` 核心模块
- [ ] 在 room.ts store 中集成 MatchMaker
- [ ] 实现 `quickMatch(gameType)` 方法
- [ ] 匹配状态管理（matching, timeout）

#### 3.2 匹配 UI
- [ ] 游戏卡片添加"快速开始"按钮
- [ ] 匹配中显示加载动画和取消按钮
- [ ] 匹配成功自动进入桌子
- [ ] 匹配超时提示（建议邀请好友）

**匹配逻辑**：
```typescript
async function quickMatch(gameType: GameType) {
  // 1. 查找等待中的公开桌
  const waitingTable = tableManager.getWaitingTables(gameType)[0]
  if (waitingTable) {
    joinGameTable(waitingTable.tableId)
    return
  }

  // 2. 创建新桌并等待
  createGameTable(gameType, true) // public = true
  matchMaker.addToQueue(myId, gameType)

  // 3. 超时处理
  setTimeout(() => {
    if (still_matching) {
      showTimeoutHint()
    }
  }, 60000)
}
```

#### 3.3 匹配队列同步
- [ ] 广播匹配请求到网络
- [ ] 其他节点收到匹配请求自动加入
- [ ] 桌子满员后停止匹配

**测试要点**：
- ✅ 点击快速开始后匹配流程正常
- ✅ 多人同时匹配能自动组队
- ✅ 匹配超时后正确处理
- ✅ 取消匹配后状态恢复

---

### 🟢 阶段 4：邀请系统（1-2天）

**目标**：在桌子内邀请在线好友，被邀请者收到通知

#### 4.1 集成 InviteManager
- [x] 创建 `invite-manager.ts` 核心模块
- [ ] 在 room.ts store 中集成 InviteManager
- [ ] 实现 `inviteToTable(tableId, peerId)` 方法
- [ ] 处理邀请网络消息

#### 4.2 邀请 UI
- [ ] 游戏桌内"邀请好友"按钮
- [ ] 邀请对话框显示在线好友列表
- [ ] 点击邀请发送网络消息
- [ ] 已邀请的显示"已邀请"状态

**代码参考**：
```typescript
// room.ts
function invitePeerToTable(peerId: string) {
  if (!currentTableId.value) return
  
  const table = gameTables.get(currentTableId.value)
  const tableNumber = tableManager.getTableNumber(currentTableId.value)
  
  if (!table || !tableNumber) return
  
  const invite = inviteManager.createInvite(
    myId.value,
    peerId,
    currentTableId.value,
    tableNumber,
    table.gameType,
    `${myProfile.value.nick} 邀请你加入游戏`,
  )
  
  mesh?.sendTo(peerId, {
    kind: 'invite-send',
    invite,
  })
}
```

#### 4.3 邀请通知
- [ ] 创建浮动通知组件 `InviteNotification.vue`
- [ ] 收到邀请时显示通知（右上角）
- [ ] 点击"加入"直接进入桌子
- [ ] 点击"拒绝"发送拒绝消息
- [ ] 邀请5分钟后自动过期

**UI 参考**：
```vue
<div class="invite-toast">
  <div class="toast-icon">🎮</div>
  <div class="toast-content">
    <strong>{{ fromNick }}</strong> 邀请你加入
    <span class="game-name">{{ gameName }}</span>
    <span class="table-number">#{{ tableNumber }}</span>
  </div>
  <div class="toast-actions">
    <button class="btn-accept" @click="accept">加入</button>
    <button class="btn-decline" @click="decline">拒绝</button>
  </div>
</div>
```

#### 4.4 分享链接
- [ ] 桌子内"复制链接"按钮
- [ ] 生成包含桌号的链接
- [ ] 从 URL 参数解析桌号（`?table=1234`）
- [ ] 应用启动时自动加入

**测试要点**：
- ✅ 邀请发送成功
- ✅ 被邀请者收到通知
- ✅ 接受邀请后成功加入
- ✅ 拒绝邀请后发送方收到通知
- ✅ 分享链接可以直接加入

---

### 🔵 阶段 5：UI/UX 优化（1-2天）

**目标**：优化创建桌子流程，减少 UI 占比

#### 5.1 侧边抽屉式创建
- [ ] 创建 `CreateTableDrawer.vue` 组件
- [ ] 从右侧滑入的抽屉动画
- [ ] 分步引导（游戏选择 → 可见性 → 密码）
- [ ] 移动端适配（底部弹窗）

**抽屉结构**：
```vue
<template>
  <transition name="drawer">
    <div v-if="show" class="drawer-mask" @click.self="close">
      <div class="drawer">
        <header>
          <h3>创建游戏桌</h3>
          <button @click="close">×</button>
        </header>
        <div class="drawer-body">
          <!-- 步骤1: 选择游戏 -->
          <!-- 步骤2: 设置可见性 -->
          <!-- 步骤3: 设置密码（可选） -->
        </div>
        <footer>
          <button @click="create">创建</button>
        </footer>
      </div>
    </div>
  </transition>
</template>

<style>
.drawer {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: min(400px, 90vw);
  background: var(--panel);
  box-shadow: var(--shadow-pop);
  animation: slideIn 0.3s;
}

@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
</style>
```

#### 5.2 游戏卡片改版
- [ ] 横向卡片布局（图标 + 信息 + 按钮）
- [ ] 悬停效果优化
- [ ] 快速开始和创建桌子按钮突出
- [ ] 添加游戏规则提示（tooltip）

#### 5.3 桌子列表优化
- [ ] 网格布局改为列表布局（更紧凑）
- [ ] 状态徽章颜色优化（等待🟢 / 游戏中🔵 / 已结束⚫）
- [ ] 添加过滤器（按游戏类型/状态）
- [ ] 空状态优化

#### 5.4 桌子内视图优化
- [ ] 头部显示桌号和分享按钮
- [ ] 玩家列表头像尺寸调整
- [ ] 聊天框优化（自动滚动到底部）
- [ ] 邀请对话框改为侧边面板

**测试要点**：
- ✅ 抽屉动画流畅
- ✅ 移动端体验良好
- ✅ 所有交互响应快速
- ✅ 视觉层次清晰

---

### 🟣 阶段 6：扩展性优化（1天）

**目标**：为未来更多游戏做好架构准备

#### 6.1 游戏注册表
- [ ] 创建 `game-registry.ts`
- [ ] 游戏插件接口定义
- [ ] 动态注册游戏组件
- [ ] 游戏验证规则

**插件接口**：
```typescript
interface GamePlugin {
  meta: GameMeta
  component: Component
  
  // 生命周期
  onInit?(table: GameTable): void
  onStart?(table: GameTable): void
  onEnd?(table: GameTable): void
  
  // 状态验证
  validateMove?(move: unknown): boolean
  checkGameOver?(state: unknown): boolean
}

// 注册游戏
gameRegistry.register({
  meta: GOMOKU_META,
  component: GomokuGame,
  validateMove: (move) => { /* ... */ },
  checkGameOver: (state) => { /* ... */ },
})
```

#### 6.2 游戏状态序列化
- [ ] 统一的状态序列化接口
- [ ] 使用 MessagePack 压缩大型状态
- [ ] 增量更新优化

#### 6.3 消息协议版本控制
- [ ] 消息版本号字段
- [ ] 向后兼容处理
- [ ] 版本不匹配提示

#### 6.4 性能优化
- [ ] 虚拟滚动（桌子列表）
- [ ] 防抖/节流（网络消息）
- [ ] Web Worker 处理复杂计算

**测试要点**：
- ✅ 新游戏能快速集成
- ✅ 旧版本客户端兼容
- ✅ 大量桌子时性能稳定
- ✅ 网络流量合理

---

## 实施时间表

```
Week 1:
Mon-Tue:  阶段1 - 核心桌号系统
Wed:      阶段2 - 密码保护桌
Thu-Fri:  阶段3 - 快速匹配

Week 2:
Mon-Tue:  阶段4 - 邀请系统
Wed-Thu:  阶段5 - UI/UX优化
Fri:      阶段6 - 扩展性优化

Week 3:
Mon-Tue:  测试和修复
Wed:      文档和部署
```

**总计：约 10-12 个工作日**

---

## 关键决策点

### 1. 桌号生成策略

**选项 A**：客户端生成 + 碰撞重试
- ✅ 简单，不依赖服务端
- ❌ 可能碰撞（概率极低）

**选项 B**：服务端中心化分配
- ✅ 绝对唯一
- ❌ 需要服务端改造

**推荐**：选项 A（当前 P2P 架构下最合适）

### 2. 密码验证方式

**选项 A**：客户端哈希 + P2P 验证
- ✅ 不需要服务端
- ❌ 桌主可以看到所有尝试

**选项 B**：服务端验证
- ✅ 更安全
- ❌ 需要服务端支持

**推荐**：选项 A（足够安全，且符合当前架构）

### 3. 匹配实现方式

**选项 A**：客户端 P2P 匹配
- ✅ 去中心化
- ❌ 匹配效率较低

**选项 B**：服务端匹配池
- ✅ 匹配效率高
- ❌ 需要服务端改造

**推荐**：选项 A（先实现基础版本，后续优化）

---

## 风险与挑战

### 风险 1：桌号碰撞

**概率**：4位数字空间 10,000，如果同时在线 100 个桌子，碰撞概率 < 1%

**缓解措施**：
- 碰撞时自动递增到 5-6 位
- 延迟回收桌号
- 监控碰撞率，必要时调整策略

### 风险 2：P2P 网络分区

**场景**：A 和 B 都创建了桌号 1234（网络分区导致未同步）

**缓解措施**：
- 桌号包含创建者 ID 的哈希（如 `1234-a3f`）
- 重连后检测冲突并合并或重命名

### 风险 3：匹配超时

**场景**：用户匹配很久没有找到对手

**缓解措施**：
- 60秒超时提示
- 建议邀请好友或降低要求
- 显示当前等待人数

### 风险 4：邀请垃圾消息

**场景**：恶意用户疯狂发送邀请

**缓解措施**：
- 频率限制（5秒内最多3个邀请）
- 拉黑功能
- 邀请自动过期

---

## 成功指标

### 功能指标
- ✅ 桌号加入成功率 > 99%
- ✅ 快速匹配平均等待时间 < 30秒
- ✅ 邀请送达率 > 95%
- ✅ 密码验证准确率 100%

### 性能指标
- ✅ 大厅加载时间 < 1秒
- ✅ 创建桌子响应时间 < 500ms
- ✅ 加入桌子响应时间 < 1秒
- ✅ 100个桌子时 UI 流畅（60fps）

### 用户体验指标
- ✅ 从大厅到游戏开始 < 3次点击
- ✅ 移动端适配良好
- ✅ 错误提示清晰易懂
- ✅ 无需阅读文档即可使用

---

## 后续优化方向

### 短期（1-2周）
- [ ] 桌子历史记录
- [ ] 常玩好友快速邀请
- [ ] 桌子收藏功能
- [ ] 断线重连恢复桌子

### 中期（1-2月）
- [ ] 匹配算法优化（技能匹配）
- [ ] 游戏回放系统
- [ ] 观战弹幕功能
- [ ] 成就和排行榜

### 长期（3-6月）
- [ ] 服务端辅助匹配
- [ ] 跨设备同步
- [ ] 锦标赛模式
- [ ] AI 对手

---

## 总结

本实施计划将游戏大厅改进拆解为 6 个阶段，每个阶段目标明确、可测试。核心原则：

1. **渐进式改进**：每个阶段都产出可用功能
2. **用户优先**：优先实现用户最需要的功能（桌号、匹配）
3. **架构清晰**：模块化设计，易于扩展
4. **测试驱动**：每个阶段都有明确的测试要点

预计 **10-12 个工作日**完成所有核心功能，之后可以根据用户反馈持续优化。
