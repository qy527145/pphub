# 游戏系统设计

pphub 内置轻量小游戏，复用现有 P2P 架构（无需额外服务器）。支持游戏大厅、游戏桌、旁观、桌内聊天、鼠标位置共享，以及好友邀请与快速匹配组桌。

## 核心概念

- **游戏大厅（GameLobby）**：浏览可玩游戏、创建游戏桌、快速匹配、接受邀请。
- **游戏桌（GameTable）**：一局游戏的容器，含玩家、旁观者、游戏状态、桌内聊天。
- **游戏类别**：单机（对 AI）、双人、多人。
- **旁观模式**：公开桌允许他人观战，旁观者可聊天但不参与操作。

## 文件结构

```
web/src/
├── core/
│   ├── games.ts            # 游戏元信息（类型/名称/图标/人数/类别）与工具
│   └── invite-manager.ts   # 邀请（发送方状态）
├── utils/
│   ├── gomoku.ts           # 五子棋逻辑
│   ├── xiangqi.ts          # 中国象棋逻辑
│   ├── chomp.ts            # Chomp 逻辑（含 minimax AI）
│   └── doudizhu.ts         # 斗地主逻辑（洗发牌、叫地主、牌型识别/比较、出牌流程）
├── components/
│   ├── GameLobby.vue       # 游戏大厅
│   ├── GameTable.vue       # 游戏桌容器（玩家列表 / 游戏区 / 聊天）
│   ├── ChompGame.vue
│   ├── GomokuGame.vue
│   ├── XiangqiGame.vue
│   ├── DoudizhuGame.vue
│   └── InviteNotification.vue  # 邀请通知（可堆叠、自动过期）
└── stores/
    └── room.ts             # 游戏桌 / 邀请 / 匹配的状态与方法
```

## 已实现游戏

| 游戏 | 类别 | 人数 | 说明 |
|------|------|------|------|
| 有毒的巧克力（Chomp） | 单机 | 1 | 板尺寸 3–10 行 × 3–12 列；AI 用 minimax + 记忆化，先手必胜 |
| 五子棋 | 双人 | 2 | 15×15，黑先，显示上一手与获胜连线，支持旁观 |
| 中国象棋 | 双人 | 2 | 完整走子规则，红先，显示可走位置，支持旁观 |
| 斗地主 | 多人 | 3 | 桌主开局洗发牌并广播完整状态；叫地主、出牌、要不起（pass）全流程可玩 |

## 状态同步

- 游戏状态经 `game-move` 消息 P2P 广播；各端本地保留 `gameState`，`watch` 到远端状态后应用。
- **单调进度计数器防乱序**：只有当远端状态的进度计数**严格大于**本地时才覆盖，避免旧消息回滚棋局。
  - 五子棋：`moves`；象棋：`history.length`；斗地主：`moveCount`（因「要不起」不改变手牌数，需独立计数器）。
- 斗地主采用**桌主发牌**模型：仅 `hostId` 在开局时洗牌并广播完整状态，其余玩家被动接收。
  - 已知限制：完整状态会广播给全部 3 名玩家（UI 隐藏他人手牌，但数据可见）；真正的隐藏信息需按玩家分发发牌，暂未实现。

## 消息协议（ControlMessage 片段）

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

## 邀请与匹配

- **邀请**：接收方以 store 的 `pendingInvites` 响应式数组为权威来源（`invite-manager` 仅管理发送方）；通知按 `expiresAt` 自动过期消失，可堆叠展示。同桌邀请去重，已在目标桌时忽略。
- **快速匹配**：两端互发 `match-request`，用 peerId 字典序做 tie-break（仅较小者建桌 `matchWith`），避免双方各自建桌的竞态。

## 扩展新游戏

1. 在 `utils/` 写纯逻辑（初始化、走子、胜负判定），带单调进度字段。
2. 在 `core/games.ts` 注册元信息（类型、名称、图标、人数、类别）。
3. 新增 `XxxGame.vue`，`watch` 远端状态并按进度计数器应用。
4. 在 `GameTable.vue` 的游戏区 `v-else-if` 中挂载组件。

## 构建与运行

```bash
cd web && npm install && npm run build   # 构建前端（会被 Rust 以 rust-embed 内嵌）
cd .. && cargo run                        # 启动 pphub
```

访问 `http://localhost:8848`，侧边栏进入「游戏大厅」。
