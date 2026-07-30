# 游戏大厅架构设计文档

## 一、核心问题与解决方案

### 1.1 桌号系统（公开+加密）

**问题**：用户无法通过简单的桌号快速加入游戏

**解决方案**：
- **公开桌**：4-6位数字桌号（如 `1234`），服务端维护桌号→tableId 映射
- **加密桌**：桌号 + 密码（如 `1234:pass123`），密码加盐哈希后验证
- **桌号生成策略**：
  - 服务端维护桌号池（1000-999999）
  - 碰撞时自动重新分配
  - 桌子销毁后桌号回收（延迟5分钟避免立即重用）

**数据结构**：
```typescript
interface TableRegistry {
  tableNumber: string       // 4-6位数字桌号
  tableId: string          // 内部唯一ID
  password?: string        // 加密桌的密码哈希（bcrypt）
  createdAt: number
  expiresAt?: number       // 桌子过期时间
}
```

### 1.2 交互优化

**问题**：创建桌子的对话框 UI 占比太高，流程不流畅

**解决方案 - 分步引导流程**：

**Step 1: 快速入口（主界面）**
```
[五子棋]  →  [快速开始] [创建桌子]
[象棋]    →  [快速开始] [创建桌子]
[斗地主]  →  [快速开始] [创建桌子]
```

**Step 2: 创建桌子（侧边抽屉/底部弹窗）**
```
┌─────────────────────────┐
│ 创建游戏桌              │
├─────────────────────────┤
│ 游戏：五子棋 ✓          │
│                         │
│ ○ 公开桌（任何人可加入）│
│ ● 私密桌（仅邀请）      │
│                         │
│ [ ] 设置密码            │
│   └→ 输入密码: [____]   │
│                         │
│        [创建] [取消]    │
└─────────────────────────┘
```

**Step 3: 桌子创建后**
```
✓ 桌号: #1234 (已复制到剪贴板)
分享链接: https://app.com?table=1234

[邀请好友] [开始游戏]
```

### 1.3 加入桌子的方式

**方式1: 输入桌号**
```
┌─────────────────────┐
│ 加入游戏            │
│                     │
│ 桌号: [____]        │
│ 密码: [____] (可选) │
│                     │
│    [加入] [取消]    │
└─────────────────────┘
```

**方式2: 点击大厅列表**
```
大厅显示所有公开桌：
┌──────────────────────────────┐
│ #1234 五子棋 等待中 (1/2)    │
│ 桌主: 张三                    │
│           [加入] [旁观]       │
├──────────────────────────────┤
│ #5678 象棋 游戏中 (2/2)      │
│ 桌主: 李四                    │
│                [旁观]         │
└──────────────────────────────┘
```

**方式3: 分享链接**
```
https://app.com?table=1234
https://app.com?table=1234&pwd=abc123 (加密桌)
```

**方式4: 邀请通知**
```
系统通知：张三邀请你加入五子棋桌 #1234
[立即加入] [稍后]
```

### 1.4 匹配与邀请系统

**快速匹配流程**：
```
1. 用户点击"快速开始"
2. 系统查找等待中的公开桌（同游戏类型）
3. 如有空位 → 直接加入
4. 如无空位 → 自动创建公开桌并等待
5. 匹配超时（60s）→ 提示用户邀请好友或返回大厅
```

**邀请系统**：
```typescript
interface Invitation {
  inviteId: string
  fromPeerId: string
  toPeerId: string
  tableId: string
  tableNumber: string
  gameType: GameType
  message?: string
  createdAt: number
  expiresAt: number  // 5分钟过期
  status: 'pending' | 'accepted' | 'declined' | 'expired'
}
```

**邀请流程**：
1. 桌主点击"邀请好友"，选择在线好友
2. 发送邀请消息（通过 mesh.sendTo）
3. 被邀请者收到通知，显示浮动卡片
4. 点击"加入"→ 直接进入桌子（跳过密码验证）
5. 点击"拒绝"→ 发送拒绝消息

## 二、架构设计

### 2.1 分层架构

```
┌─────────────────────────────────────┐
│         UI Layer (Vue组件)          │
│  GameLobby | GameTable | GameView   │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│      State Management (Pinia)       │
│         useGameLobbyStore           │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│       Game System (Core)            │
│  TableManager | MatchMaker |        │
│  InviteManager | GameRegistry       │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│      Network Layer (Mesh)           │
│  P2P Communication | Signaling      │
└─────────────────────────────────────┘
```

### 2.2 核心模块

#### TableManager（桌子管理器）
```typescript
class TableManager {
  // 桌号生成与验证
  generateTableNumber(): string
  verifyPassword(tableNumber: string, password: string): boolean
  
  // 桌子生命周期
  createTable(config: CreateTableConfig): GameTable
  joinTable(tableNumber: string, password?: string): boolean
  leaveTable(tableId: string): void
  destroyTable(tableId: string): void
  
  // 桌子查询
  getTableByNumber(tableNumber: string): GameTable | null
  getPublicTables(gameType?: GameType): GameTable[]
  getTableState(tableId: string): TableState
}
```

#### MatchMaker（匹配器）
```typescript
class MatchMaker {
  // 快速匹配
  quickMatch(gameType: GameType): Promise<GameTable>
  cancelMatch(peerId: string): void
  
  // 匹配队列管理
  addToQueue(peerId: string, gameType: GameType): void
  removeFromQueue(peerId: string, gameType: GameType): void
  findMatch(peerId: string, gameType: GameType): GameTable | null
  
  // 匹配策略
  matchBySkill?: (peers: string[]) => string[]
  matchByLatency?: (peers: string[]) => string[]
}
```

#### InviteManager（邀请管理器）
```typescript
class InviteManager {
  // 发送邀请
  sendInvite(fromPeerId: string, toPeerId: string, tableId: string): Invitation
  sendBatchInvite(fromPeerId: string, toPeerIds: string[], tableId: string): void
  
  // 处理邀请
  acceptInvite(inviteId: string): boolean
  declineInvite(inviteId: string): void
  
  // 邀请查询
  getPendingInvites(peerId: string): Invitation[]
  getInviteByLink(link: string): Invitation | null
}
```

#### GameRegistry（游戏注册表）
```typescript
class GameRegistry {
  // 游戏注册
  registerGame(meta: GameMeta, component: Component): void
  
  // 游戏查询
  getGame(gameType: GameType): GameMeta
  getAllGames(): GameMeta[]
  getGamesByCategory(category: GameCategory): GameMeta[]
  
  // 游戏验证
  validateGameState(gameType: GameType, state: unknown): boolean
  canStartGame(gameType: GameType, playerCount: number): boolean
}
```

### 2.3 消息协议扩展

```typescript
// 新增消息类型
type GameLobbyMessage =
  | { kind: 'table-register'; tableNumber: string; table: GameTable }
  | { kind: 'table-unregister'; tableNumber: string }
  | { kind: 'table-update'; tableNumber: string; patch: Partial<GameTable> }
  | { kind: 'table-join-request'; tableNumber: string; password?: string }
  | { kind: 'table-join-response'; success: boolean; reason?: string }
  | { kind: 'invite-send'; invite: Invitation }
  | { kind: 'invite-accept'; inviteId: string }
  | { kind: 'invite-decline'; inviteId: string }
  | { kind: 'match-join-queue'; gameType: GameType }
  | { kind: 'match-leave-queue'; gameType: GameType }
  | { kind: 'match-found'; tableId: string; tableNumber: string }
```

### 2.4 数据流

**创建桌子**：
```
User → UI → Store.createTable()
       ↓
  TableManager.createTable()
       ↓
  生成桌号 + 验证密码
       ↓
  Mesh.broadcast('table-register')
       ↓
  其他节点收到 → 更新本地桌子列表
```

**加入桌子**：
```
User → 输入桌号/点击列表
       ↓
  Store.joinTableByNumber(number, password?)
       ↓
  TableManager.verifyPassword() (如需要)
       ↓
  Mesh.sendTo(host, 'table-join-request')
       ↓
  桌主验证并响应
       ↓
  加入成功 → 切换到 GameTable 视图
```

**快速匹配**：
```
User → 点击"快速开始"
       ↓
  MatchMaker.quickMatch()
       ↓
  查找公开等待桌 → 找到 → 直接加入
       ↓
  未找到 → 创建公开桌 → 广播匹配请求
       ↓
  其他匹配者收到 → 自动加入
```

## 三、UI/UX 设计

### 3.1 游戏大厅布局

```
┌─────────────────────────────────────────────────────┐
│  🎮 游戏大厅                    [输入桌号] [创建桌子] │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────────────────────────────────────────┐  │
│  │  五子棋 ⚫⚪                                  │  │
│  │  双人对弈，五子连珠获胜                      │  │
│  │                                               │  │
│  │  [快速开始]  [创建桌子]                      │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────┐  │
│  │  中国象棋 ♟️                                  │  │
│  │  双人对弈，将死对方获胜                      │  │
│  │                                               │  │
│  │  [快速开始]  [创建桌子]                      │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                      │
│  公开游戏桌 (3)                                      │
│                                                      │
│  ┌────────────────────────────────────────────┐    │
│  │ #1234  五子棋  等待中 (1/2)  🟢           │    │
│  │ 桌主: 张三                                  │    │
│  │ 玩家: [张三] [空位]                         │    │
│  │                        [加入游戏] [旁观]   │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
│  ┌────────────────────────────────────────────┐    │
│  │ #5678  象棋  游戏中 (2/2)  🔵             │    │
│  │ 桌主: 李四                                  │    │
│  │ 玩家: [李四] [王五]  旁观: 2人             │    │
│  │                                   [旁观]   │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
│  ┌────────────────────────────────────────────┐    │
│  │ #9012  🔒 斗地主  等待中 (2/3)  🟢        │    │
│  │ 桌主: 赵六         需要密码                │    │
│  │                        [加入游戏]          │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### 3.2 侧边抽屉 - 创建桌子

```
                                    ┌───────────────────┐
                                    │ 创建游戏桌        │
                                    ├───────────────────┤
                                    │                   │
                                    │ 游戏: 五子棋 ✓   │
                                    │                   │
                                    │ ┌───────────────┐ │
                                    │ │ ○ 公开桌      │ │
                                    │ │   所有人可见  │ │
                                    │ └───────────────┘ │
                                    │ ┌───────────────┐ │
                                    │ │ ● 私密桌      │ │
                                    │ │   仅邀请可见  │ │
                                    │ └───────────────┘ │
                                    │                   │
                                    │ ┌───────────────┐ │
                                    │ │ ☑ 设置密码    │ │
                                    │ │ [________]    │ │
                                    │ └───────────────┘ │
                                    │                   │
                                    │   [创建] [取消]   │
                                    │                   │
                                    └───────────────────┘
```

### 3.3 浮动通知 - 邀请提示

```
┌─────────────────────────────────────┐
│ 🎮 游戏邀请                          │
│                                      │
│ 张三邀请你加入五子棋游戏桌 #1234     │
│                                      │
│ [立即加入]  [稍后]  [×]              │
└─────────────────────────────────────┘
```

### 3.4 桌子内视图增强

在现有基础上添加：

```
┌──────────────────────────────────────────┐
│ ⚫ 五子棋  #1234  等待中                  │
│                  [分享] [邀请] [离开]    │
├──────────────────────────────────────────┤
│                                           │
│ 分享链接: https://app.com?table=1234     │
│ [复制链接]                                │
│                                           │
│ 或通过桌号加入: #1234                     │
│                                           │
└──────────────────────────────────────────┘
```

## 四、实现优先级

### P0（核心功能）
1. ✅ 桌号生成与管理
2. ✅ 输入桌号快速加入
3. ✅ 公开桌列表展示
4. ✅ 创建桌子 UI 优化（侧边抽屉）

### P1（重要功能）
5. ✅ 分享链接（带桌号参数）
6. ✅ 邀请系统（发送/接收/通知）
7. ✅ 快速匹配（自动加入或创建）
8. ✅ 密码保护桌（加密桌）

### P2（优化功能）
9. ⏱️ 桌子过期自动清理
10. ⏱️ 匹配超时处理
11. ⏱️ 断线重连恢复桌子状态
12. ⏱️ 桌子历史记录

### P3（扩展功能）
13. 💡 匹配算法优化（技能/延迟）
14. 💡 游戏回放系统
15. 💡 观战弹幕/评论
16. 💡 桌子收藏/快速加入

## 五、技术挑战与解决方案

### 5.1 桌号碰撞

**问题**：多人同时创建桌子可能生成相同桌号

**解决方案**：
- 客户端生成随机桌号 + 后端验证（带重试）
- 使用原子性操作确保桌号唯一
- 碰撞时自动重新生成（最多3次）

### 5.2 P2P 网络中的桌子同步

**问题**：没有中心服务器，如何保证所有节点看到一致的桌子列表？

**解决方案**：
- **最终一致性模型**：
  - 桌主负责桌子的权威状态
  - 其他节点定期向桌主请求同步
  - 桌主离线 → 转移给第一个玩家
  - 所有玩家离线 → 桌子自动销毁

- **冲突解决**：
  - 使用向量时钟（Vector Clock）追踪版本
  - 以桌主的状态为准
  - 玩家加入/离开时全量广播

### 5.3 加密桌的密码验证

**问题**：P2P 环境下如何安全验证密码？

**解决方案**：
- 客户端生成盐值 + 密码哈希（SHA-256）
- 加入请求携带哈希值
- 桌主比对哈希值（不传输明文）
- 防暴力破解：3次失败后锁定5分钟

### 5.4 扩展更多游戏

**设计原则**：
- 每个游戏实现统一接口（GamePlugin）
- 游戏逻辑与桌子管理解耦
- 支持热插拔（动态加载游戏组件）

**接口定义**：
```typescript
interface GamePlugin {
  meta: GameMeta
  component: Component
  
  // 游戏生命周期
  onInit(table: GameTable): void
  onStart(table: GameTable): void
  onMove(table: GameTable, move: GameMove): void
  onEnd(table: GameTable): void
  
  // 状态管理
  validateMove(table: GameTable, move: GameMove): boolean
  computeNextState(table: GameTable, move: GameMove): unknown
  checkGameOver(table: GameTable): boolean
  
  // 序列化（用于网络传输）
  serializeState(state: unknown): string
  deserializeState(data: string): unknown
}
```

## 六、性能优化

### 6.1 减少网络流量
- 增量更新（只传变化的字段）
- 消息合并（批量发送）
- 压缩大型状态（使用 MessagePack）

### 6.2 UI 渲染优化
- 虚拟滚动（桌子列表）
- 防抖/节流（鼠标位置同步）
- Web Worker 处理复杂游戏逻辑

### 6.3 内存管理
- 桌子自动清理（30分钟无活动）
- 历史消息分页加载
- 图片/资源懒加载

## 七、总结

本方案通过以下改进解决了现有问题：

1. **桌号系统**：4-6位数字桌号 + 密码保护，快速加入
2. **UI 优化**：侧边抽屉式创建流程，减少占用空间
3. **匹配与邀请**：快速匹配 + P2P 邀请 + 分享链接，多种方式连接玩家
4. **可扩展架构**：模块化设计 + 游戏插件系统，支持无限扩展

核心理念：**简单、快速、灵活**
- 简单：一个桌号即可加入
- 快速：快速匹配 3 秒内开始游戏
- 灵活：支持公开/私密/密码保护，满足不同场景
