# 游戏系统设计文档

## 概述

全新的游戏系统，支持游戏大厅、游戏桌、旁观模式、游戏内聊天和鼠标位置共享等功能。

## 架构设计

### 核心概念

1. **游戏大厅（Game Lobby）**：展示所有可玩的游戏，用户可以创建或加入游戏桌
2. **游戏桌（Game Table）**：一局游戏的容器，包含玩家、旁观者、游戏状态等
3. **游戏类别**：单机游戏、双人游戏、多人游戏
4. **旁观模式**：允许其他用户观看公开的游戏桌
5. **游戏内聊天**：玩家和旁观者可以实时聊天
6. **鼠标位置共享**：显示所有参与者的鼠标位置

### 文件结构

```
web/src/
├── core/
│   └── games.ts                    # 游戏系统核心类型和工具函数
├── utils/
│   ├── gomoku.ts                   # 五子棋逻辑（复用现有）
│   ├── xiangqi.ts                  # 中国象棋逻辑
│   ├── chomp.ts                    # 有毒的巧克力（Chomp）逻辑
│   └── doudizhu.ts                 # 斗地主逻辑（基础框架）
├── components/
│   ├── GameLobby.vue               # 游戏大厅组件
│   ├── GameTable.vue               # 游戏桌容器组件
│   ├── ChompGame.vue               # 有毒的巧克力游戏组件
│   ├── GomokuGame.vue              # 五子棋游戏组件
│   ├── XiangqiGame.vue             # 中国象棋游戏组件
│   └── ...（其他游戏组件待实现）
└── stores/
    └── room.ts                     # 添加游戏桌管理逻辑
```

## 已实现的游戏

### 1. 有毒的巧克力（Chomp）

**类型**：单机游戏（对战 AI）

**规则**：
- 轮流吃巧克力，从选中的格子到右上角全部被吃掉
- 左下角的巧克力有毒，吃到就输
- AI 使用记忆化深搜的最佳策略，保证获胜

**特点**：
- 可自定义巧克力板尺寸（3-10 行 × 3-12 列）
- AI 使用 Minimax + 记忆化，计算最佳走法
- 先手必胜的游戏（AI 总能赢）

**实现文件**：
- 逻辑：`utils/chomp.ts`
- UI：`components/ChompGame.vue`

### 2. 五子棋

**类型**：双人游戏

**规则**：
- 15×15 棋盘
- 黑子先手，白子后手
- 先连成五子者获胜

**特点**：
- 支持旁观模式
- 显示上一手落子位置
- 高亮获胜连线

**实现文件**：
- 逻辑：`utils/gomoku.ts`（复用现有）
- UI：`components/GomokuGame.vue`

### 3. 中国象棋

**类型**：双人游戏

**规则**：
- 标准中国象棋规则
- 红方先手，黑方后手
- 将死对方获胜

**特点**：
- 完整的棋子移动规则（将、士、象、马、车、炮、兵）
- 棋盘显示楚河汉界
- 显示可走位置
- 支持旁观模式

**实现文件**：
- 逻辑：`utils/xiangqi.ts`
- UI：`components/XiangqiGame.vue`

### 4. 斗地主（基础框架）

**类型**：三人游戏

**状态**：逻辑框架已实现，UI 待开发

**已实现**：
- 洗牌和发牌
- 牌型识别（单张、对子、三张、炸弹等）
- 牌型比较

**待实现**：
- 叫地主逻辑
- 出牌 UI
- 游戏流程控制

**实现文件**：
- 逻辑：`utils/doudizhu.ts`

## 游戏大厅功能

### 游戏分类

- **全部**：显示所有游戏
- **单机游戏**：与 AI 对战的游戏
- **双人游戏**：需要两名玩家的游戏
- **多人游戏**：需要三名及以上玩家的游戏

### 游戏卡片

每个游戏卡片显示：
- 游戏图标和名称
- 游戏描述
- 所需玩家数量
- 是否支持旁观
- 公开游戏桌列表（如果有）
- 创建游戏桌按钮

### 游戏桌管理

**创建游戏桌**：
- 公开桌：任何人都可以看到并加入/旁观
- 私密桌：只有被邀请的人可以加入

**加入游戏桌**：
- 作为玩家加入（占据玩家位）
- 作为旁观者加入（不参与游戏，只能观看）

## 游戏桌界面

### 布局

```
┌─────────────────────────────────────────────────┐
│ [游戏名称]        [状态]          [离开按钮]     │
├──────────┬──────────────────────────┬───────────┤
│          │                          │           │
│ 玩家列表 │      游戏区域            │ 聊天框    │
│          │   （游戏画面）           │           │
│ 旁观者   │                          │           │
│          │   远程鼠标指针显示       │           │
│ [开始]   │                          │           │
│          │                          │           │
└──────────┴──────────────────────────┴───────────┘
```

### 玩家面板（左侧）

- 显示所有玩家（带头像和昵称）
- 桌主标识
- 当前回合玩家高亮
- 旁观者列表
- 开始游戏按钮（仅桌主可见）

### 游戏区域（中间）

- 游戏画面（由具体游戏组件渲染）
- 远程鼠标指针（显示其他参与者的鼠标位置）
- 鼠标移动时自动广播位置

### 聊天面板（右侧）

- 实时聊天消息
- 区分玩家和旁观者
- 显示消息发送者和时间
- 支持所有参与者聊天

## 消息协议

新增的游戏桌消息类型（添加到 `ControlMessage`）：

```typescript
| { kind: 'table-create'; tableId: string; table: unknown }
| { kind: 'table-join'; tableId: string }
| { kind: 'table-spectate'; tableId: string }
| { kind: 'table-leave'; tableId: string }
| { kind: 'table-start'; tableId: string }
| { kind: 'game-move'; tableId: string; moveData: unknown }
| { kind: 'game-chat'; tableId: string; chatMsg: unknown }
| { kind: 'mouse-pos'; tableId: string; pos: unknown }
```

## Store 状态管理

新增到 `room.ts`：

```typescript
// 游戏桌映射：tableId → GameTable
const gameTables = reactive(new Map<string, GameTable>())

// 当前加入的游戏桌 ID
const currentTableId = ref<string | null>(null)

// 游戏内聊天消息：tableId → messages[]
const gameChats = reactive(new Map<string, GameChatMessage[]>())

// 游戏内鼠标位置：tableId → positions[]
const gameMousePositions = reactive(new Map<string, MousePosition[]>())
```

新增方法：
- `createGameTable(gameType, isPublic)` - 创建游戏桌
- `joinGameTable(tableId, asSpectator)` - 加入游戏桌
- `leaveGameTable()` - 离开当前游戏桌
- `startGameTable(tableId)` - 开始游戏
- `sendGameMove(tableId, moveData)` - 发送游戏动作
- `sendGameChat(tableId, text)` - 发送游戏内聊天
- `sendGameMousePos(tableId, x, y)` - 发送鼠标位置

## UI 入口

在侧边栏导航新增"游戏大厅"入口：

```typescript
{ view: 'games', icon: 'gamepad-2', label: '游戏大厅' }
```

## 待实现功能

### 你画我猜（多人游戏）

- 一人画，其他人猜
- 复用现有的白板功能
- 计分系统
- 词库管理

### 斗地主 UI

- 叫地主界面
- 手牌显示和选择
- 出牌按钮
- 游戏流程控制

### 棋类游戏增强

- **超时机制**：每步限时，超时自动判负
- **悔棋功能**：请求对手同意后悔棋
- **棋谱记录**：保存对局记录
- **复盘功能**：查看历史对局

### 游戏桌增强

- **邀请系统**：从网络视图邀请好友入桌
- **游戏记录**：保存游戏历史和统计
- **游戏设置**：自定义规则和难度
- **语音聊天**：游戏内语音对讲

## 技术要点

### 状态同步

- 游戏状态由创建者（桌主）维护
- 玩家动作通过 P2P 消息广播
- 每个客户端独立验证合法性
- 避免状态冲突和作弊

### 性能优化

- 游戏逻辑计算在 Web Worker（如需）
- 鼠标位置限流（避免频繁广播）
- 聊天消息分页加载
- 游戏桌列表虚拟滚动（如需）

### 用户体验

- 响应式布局，适配不同屏幕
- 清晰的视觉反馈（轮次指示、可走位置等）
- 友好的错误提示
- 游戏中断恢复机制

## 构建和测试

```bash
# 构建前端
cd web
npm install
npm run build

# 运行开发服务器
npm run dev

# 启动 pphub
cd ..
cargo run
```

访问 `http://localhost:8848`，点击侧边栏"游戏大厅"即可体验。

## 总结

本次重新设计的游戏系统具有以下特点：

1. **可扩展**：易于添加新游戏，只需实现游戏逻辑和 UI 组件
2. **完整**：支持游戏大厅、游戏桌、旁观、聊天等完整功能
3. **P2P**：复用现有的 P2P 架构，无需额外服务器
4. **实时**：游戏状态和聊天消息实时同步
5. **友好**：清晰的 UI 和良好的用户体验

已实现 3 个完整可玩的游戏（Chomp、五子棋、中国象棋），为后续添加更多游戏打下了坚实基础。
