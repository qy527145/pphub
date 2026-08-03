# pphub 系统技术架构文档

> 版本 v1.0 · 2026-07-27 · 基于 [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) 已确认的范围
>
> **定位**：跨平台、免安装、端到端（P2P）的隐私互联 Web 应用。除信令协商外，任何业务数据不经云端服务器；全链路默认加密（DTLS-SRTP / DTLS-SCTP）。

## 已确认的范围约束（架构前提）

1. **纯浏览器**，不做原生伴侣程序 → 无远程桌面控制、无 SSH 终端、无局域网自动发现。
2. **信令栈用 Rust**（axum + tokio），单一后端二进制。
3. **数据恒全网状 P2P**（控制/聊天/文件/白板/游戏，无论房间多大）；**媒体（屏幕/语音）按房间人数自适应**——小房间逐对端直发，大房间由服务器**扇出**（分发端到端加密密文，非 SFU 转码，服务器看不到明文）。默认房间上限 32 人。
4. **首期功能**：文件/文件夹快传 + 文本聊天、屏幕共享 + 互动白板、一起看片房、局域网离线快传；配套地基：信令握手、SAS 指纹校验、TURN 兜底。

---

## 一、架构总览

```
                    ┌──────────────────────────────────────────┐
                    │           静态托管 (HTTPS 必需)            │
                    │   Web SPA (Vue3 + TS + Vite + Tailwind)   │
                    └──────────────────────────────────────────┘
                                       │ ① 下载应用
              ┌────────────────────────┼────────────────────────┐
              ▼                                                  ▼
      ┌───────────────┐                                  ┌───────────────┐
      │   浏览器 A     │                                  │   浏览器 B     │
      │  (Peer)       │                                  │  (Peer)       │
      └───────┬───────┘                                  └───────┬───────┘
              │  ② WSS 信令 (仅交换 SDP/ICE，不过业务数据)          │
              │        ┌──────────────────────────┐               │
              └───────▶│  信令服务器 (Rust/axum)   │◀──────────────┘
                       │  房间管理 + SDP/ICE 中继   │
                       └──────────────────────────┘
              │                                                  │
              │  ③ ICE 收集候选                                   │
              │        ┌────────────┐   ┌──────────────────┐     │
              ├───────▶│ STUN 服务器 │   │ TURN 中继(兜底~17%)│◀───┤
              │        └────────────┘   └──────────────────┘     │
              │                                                  │
              └━━━━━━━━━━━━━━━ ④ P2P 加密直连 ━━━━━━━━━━━━━━━━━━━┘
                     DTLS-SRTP (媒体) / DTLS-SCTP (数据通道)
                     文件 · 聊天 · 白板 · 看片同步 · 屏幕流
```

**四类流量**：① 应用静态资源（HTTPS，一次性）；② 信令（WSS，小且短）；③ NAT 穿透探测（STUN 无带宽成本 / TURN 有）；④ 全部业务数据走 P2P，端到端加密。业务数据过服务器有两种情形——**TURN 兜底**（穿透失败）与**大房间媒体扇出**（发送端只上行一份加密密文，服务器复制给各观众）；两种情形下服务器都**看不到明文**。

---

## 二、技术选型（含 2026-07 版本基线）

### 前端
| 项 | 选型 | 理由 |
|----|------|------|
| 框架 | **Vue 3 + TypeScript**（React 可平替） | PRD 首选；组合式 API 适合管理复杂 WebRTC 状态 |
| 构建 | **Vite** | 快、原生 ES module |
| 样式 | **Tailwind CSS** | PRD 指定 |
| 状态 | **Pinia**（Vue）/ Zustand（React） | 房间/连接/传输状态集中管理 |
| CRDT | **Yjs 13.6.x** | 白板/共享状态，成熟、~20KB |
| 终端渲染 | —（SSH 终端已移出范围） | |
| Worker | Web Worker + Comlink | 分块哈希、文件读写卸载出主线程 |

> **关键**：`RTCPeerConnection` 与 `RTCDataChannel` **只能在主线程**，不能转移到 Worker。因此哈希/落盘在 Worker 做，通过 `postMessage`（transferable ArrayBuffer）喂数据。

### 后端（信令）
| 项 | 选型 | 版本 |
|----|------|------|
| Web 框架 | **axum** | 0.8.x（内置 `axum::extract::ws`，底层 tokio-tungstenite） |
| 运行时 | **tokio** | 1.5x |
| 序列化 | **serde / serde_json** | 信令消息 |
| 房间状态 | **actor + mpsc-per-room**（每房间一个 task 独占状态） | 避免跨 `.await` 持锁；比 `Arc<RwLock<HashMap>>` 更稳 |
| 横向扩展（可选） | **redis 1.x pub/sub**，按房间一致性哈希 | 单机足够时不引入 |
| TLS | 反向代理（Caddy/Nginx）终止，或 rustls | WSS 必需 |

> **不要用 `tokio::sync::broadcast` 做信令扇出**：它是丢弃语义（`Lagged`），而 SDP/ICE 必须可靠送达。用**每客户端 bounded mpsc，满即断开**。

### NAT 穿透
| 项 | 选型 | 说明 |
|----|------|------|
| STUN | 公共（`stun.l.google.com:19302`）+ 自建 coturn | 无带宽成本 |
| TURN | **自建 coturn 4.15.x**（首选，流量便宜）或 **Cloudflare Realtime TURN**（$0.05/GB，前 1000GB 免费） | 约 17% 的 P2P 连接、移动网 30–40% 必须走中继 |
| TURN 鉴权 | **REST API 临时凭证**（HMAC，短时效） | 绝不在前端硬编码长期密钥 |

---

## 三、仓库结构（单 crate，前端嵌入）

> 参考 safedrive：**单 crate + 前端编译期嵌入**。`web/dist` 由 `rust-embed`
> 嵌入 `pphub` 二进制，运行时同一端口既托管网页，又提供 `/ws` 信令。分发只需
> 一个可执行文件；`cargo install` 无需 Node 工具链（`web/dist` 随仓库提交）。

```
pphub/
├── Cargo.toml                 # 单 package = "pphub"
├── build.rs                   # 确保 web/dist 存在，供 rust-embed 嵌入
├── src/
│   ├── main.rs                # CLI(clap: -H/--host, -p/--port) + 路由
│   ├── assets.rs              # 嵌入式前端静态资源 + SPA 回退
│   ├── config.rs              # 环境变量配置 (STUN/TURN/上限)
│   ├── ws.rs                  # WebSocket 升级与连接生命周期
│   ├── room.rs                # 房间注册表 (Mutex<HashMap> + 非阻塞 try_send)
│   ├── protocol.rs            # 信令消息 (serde) 定义
│   └── turn.rs                # TURN 临时凭证签发 (HMAC-REST)
├── web/                       # 前端 SPA (Vue 3 + TS + Vite)
│   ├── src/
│   │   ├── core/              # 与业务无关的 P2P 基础设施
│   │   │   ├── signaling.ts   # 信令客户端 (WSS, 重连)
│   │   │   ├── peer.ts        # 单条 RTCPeerConnection 封装 (Perfect Negotiation)
│   │   │   ├── mesh.ts        # 多端 Mesh 管理
│   │   │   ├── channels.ts    # DataChannel 抽象 (分块/背压/多通道)
│   │   │   ├── messages.ts    # control 通道应用层消息
│   │   │   ├── security.ts    # SAS 指纹校验
│   │   │   └── capabilities.ts# 浏览器能力探测与降级
│   │   ├── features/          # 各业务子系统 (chat 已落地，其余规划中)
│   │   │   ├── filetransfer/  # 文件/文件夹快传
│   │   │   ├── screenshare/   # 屏幕共享
│   │   │   ├── whiteboard/    # 白板 (Yjs + Canvas)
│   │   │   ├── watchparty/    # 看片房同步
│   │   │   └── lan/           # 局域网离线 (手输IP/二维码信令)
│   │   ├── stores/            # Pinia
│   │   └── workers/           # 哈希/落盘 Worker
│   ├── dist/                  # 构建产物：随仓库提交、被嵌入二进制
│   └── package.json
└── docs/
    ├── README.md             # 文档导航
    ├── REQ_PRD.md            # 原始产品需求
    ├── FEATURE_INVENTORY.md  # 功能可行性评估与关键决策
    ├── GAME_SYSTEM.md        # 游戏系统设计
    └── ARCHITECTURE.md       # 本文
```

> 运行：`cargo run -- -p 8848`（默认 `-H 0.0.0.0 -p 8848`）。前端改动后需
> `npm --prefix web run build` 重新产出 `web/dist` 再编译。

---

## 四、信令服务器设计

### 职责边界
**只做三件事**：房间成员管理、SDP/ICE 候选中继、TURN 临时凭证签发。**绝不接触业务数据**。

### 房间模型（actor 模式）
- 每个房间 = 一个 tokio task，独占 `Room { peers: HashMap<PeerId, mpsc::Sender<ServerMsg>> }`。
- 客户端连接 = 一个 WS task，持有到所在房间 task 的 `mpsc::Sender<RoomCmd>`。
- 所有房间状态变更串行化在房间 task 内，**无跨 await 持锁**，天然无数据竞争。
- 房间空了自动销毁（成员计数归零 → task 退出）。

### 信令消息协议（JSON over WSS）

```typescript
// 客户端 → 服务器
type ClientMsg =
  | { t: "join";      room: string; peerId: string; nick?: string }
  | { t: "leave" }
  | { t: "signal";    to: string; data: RTCSessionDescriptionInit | { candidate: RTCIceCandidateInit } }
  | { t: "turn-creds" };                       // 请求 TURN 临时凭证

// 服务器 → 客户端
type ServerMsg =
  | { t: "joined";    peerId: string; peers: PeerInfo[] }   // 现有成员列表
  | { t: "peer-join"; peer: PeerInfo }
  | { t: "peer-left"; peerId: string }
  | { t: "signal";    from: string; data: ... }             // 转发对端信令
  | { t: "turn-creds"; iceServers: RTCIceServer[]; ttl: number }
  | { t: "error";     code: string; msg: string };
```

- **加入协议**：新成员 `join` → 服务器回 `joined`（含现有成员），并向现有成员广播 `peer-join`。由**新成员发起** offer（谁后到谁发 offer，避免双向 glare）。
- **Trickle ICE**：`signal` 消息同时承载 SDP 和逐条 ICE candidate，边收集边转发，不阻塞。
- **房间上限**：服务端强制默认 32 人（`PPHUB_MAX_PEERS` 可调），满员拒绝并回 `error`。上限主要受全网状数据通道数约束（每端 N−1 条）；媒体在大房间走服务器扇出，不再是瓶颈。

### TURN 凭证签发
coturn 的 `use-auth-secret` 模式：`username = "<expiry>:<peerId>"`，`credential = base64(HMAC-SHA1(secret, username))`，TTL 建议 1–2h。密钥只在服务端，前端每次连接前拉取。

---

## 五、客户端核心架构（分层）

```
┌─────────────────────────────────────────────┐
│  features/  文件·聊天·屏幕·白板·看片·局域网   │  业务层
├─────────────────────────────────────────────┤
│  channels.ts   多路 DataChannel / 分块 / 背压  │  传输层
├─────────────────────────────────────────────┤
│  mesh.ts       全网状成员生命周期 / 自适应组网  │
│  peer.ts       单连接 (Perfect Negotiation)   │  连接层
│  security.ts   SAS 指纹校验                    │
├─────────────────────────────────────────────┤
│  signaling.ts  WSS 信令客户端 (重连)           │  信令层
└─────────────────────────────────────────────┘
```

### 5.1 连接层 — Perfect Negotiation
采用 W3C 标准的 **Perfect Negotiation** 模式统一处理 offer/answer，规避 glare：
- 按 `peerId` 字典序决定 **polite / impolite** 角色。
- 监听 `negotiationneeded` → `setLocalDescription()` → 经信令发送。
- 收到冲突 offer 时，polite 端回滚、impolite 端忽略。
- `onicecandidate` → trickle 发送；`oniceconnectionstatechange === "failed"` → `restartIce()`（并先确保信令通道已重连）；`disconnected` 设宽限计时器，可能自愈。
- 用 `RTCPeerConnection.generateCertificate()` 生成并持久化到 IndexedDB，做稳定身份指纹（配合 SAS）。

### 5.2 连接层 — 全网状成员管理与自适应组网
- 房间内 N 人 → 每端维护 N-1 条 `RTCPeerConnection`（**数据恒全网状**）。
- 由信令的 `peer-join`/`peer-left` 驱动增删连接。
- **默认上限 32**（`PPHUB_MAX_PEERS` 可调）；数据通道全网状可到几十端，媒体不再受「每端各编一份」的上行约束——见下。
- **自适应组网（客户端自行判定，无需服务端协议改动）**：`tier = 成员数(含己) > FANOUT_THRESHOLD(=8) ? 'fanout' : 'mesh'`。各端成员视图一致，算出的层级一致。
  - **数据**（control/chat/file/whiteboard/game）：**任何规模都全网状 P2P 直发**，不走扇出。
  - **媒体**（屏幕/语音）：小房间逐对端发（原生媒体轨或每对中继自编码）；大房间切到**服务器扇出**——发送端只编码一次、用群密钥加密一次、上行一次，服务器复制密文给 N−1 观众（见 6.7）。跨阈值切换时原地换路，接受一次短暂闪断。

### 5.3 传输层 — DataChannel 抽象
**多通道划分**（同一 PC 上，共享一个 SCTP 拥塞窗口，但分通道避免应用层队头阻塞）：
| 通道 | ordered | 可靠性 | 用途 |
|------|---------|--------|------|
| `control` | 有序可靠 | 是 | 握手、文件元信息、聊天、白板 op |
| `bulk` | 有序可靠 | 是 | 文件分块数据 |
| `sync` | **无序** | `maxRetransmits:0` | 看片房时钟 ping、光标/在场 |

**分块与背压（强制，否则通道崩溃）**：
- 分块 = `min(local, remote) maxMessageSize` 驱动，实操取 **16–64 KiB**（超过协商上限会抛错断通道，无跨浏览器自动分片）。
- `binaryType = "arraybuffer"`（显式设置，勿依赖默认）。
- 发送侧水位：`bufferedAmount > 1MiB` 暂停入队，监听 `bufferedamountlow`（阈值 256KiB）恢复。
- 大文件哈希/落盘在 Worker，主线程只搬运。

### 5.4 安全层 — E2EE 与 SAS 校验
- **默认加密**：DTLS-SRTP（媒体）+ DTLS/SCTP（数据）——浏览器强制，无明文模式。
- **真 E2EE 的缺口**：证书指纹经信令服务器交换，恶意服务器可中间人。**对策**：
  - 双方从 `getStats()` / SDP 取本端与对端 DTLS 指纹（SHA-256）。
  - 归一化拼接后哈希 → 生成**短认证串（SAS）**：4 个 emoji 或 6 位数字。
  - UI 引导两端**带外比对**（当面/语音/已有可信渠道）一致即确认，防 MITM。
- 纯 P2P 直连下这是可达的真端到端加密；大房间媒体扇出时，服务器只转发用**发送端群密钥**加密的密文（密钥经每对 P2P control 通道分发，绝不过服务器），端到端加密同样不破（见 6.7）。

### 5.5 能力探测与降级
`capabilities.ts` 启动时探测并写入 store，各功能据此启用/降级：

| 能力 | 缺失时降级 |
|------|-----------|
| `showSaveFilePicker`（仅 Chromium） | Safari/FF → OPFS 暂存后 `<a download>` 导出 |
| `getDisplayMedia`（桌面限定） | 移动端隐藏「屏幕共享」入口 |
| 安全上下文（HTTPS/localhost） | http 局域网 IP → 禁用摄像头/屏幕/剪贴板；数据通道、WS 中继（纯 JS 加密）、SAS 均照常 |
| 剪贴板后台监听（不存在） | 一律用「发送/聚焦同步/粘贴按钮」 |

---

## 六、各功能子系统设计

### 6.1 文件 / 文件夹快传
```
发送端                                    接收端
 选择文件/文件夹                           
 (webkitdirectory / 拖拽 entries)         
      │                                    
 control: file-offer {id,name,size,path}  ──▶  准备落盘句柄
      │                                         Chromium: showSaveFilePicker→WritableStream
      │                                         Safari/FF: OPFS createSyncAccessHandle(Worker)
 bulk: chunk[0..n] (16-64KiB, 背压)       ──▶  边收边写 (Worker)
      │                                    
 control: file-end {id, sha256}           ──▶  校验 → 完成
```
- **文件夹**：`webkitRelativePath` 保留结构；接收端在 OPFS/目录句柄下重建子目录。
- **落盘策略**：内存攒 Blob 桌面 ≤1GB、移动端更低（iOS ~1–1.5GB 被杀）；大文件必须流式。
- **多文件**：control 通道排队元信息，bulk 通道串行传输，避免 SCTP 消息交织延迟。
- **可选增强**：断点续传（记录已确认分块偏移）；同房多人时可扩展成 4.1 的 Mesh 分发（后置）。

### 6.2 文本聊天
control 通道传 `{t:"chat", from, ts, text|html|imgBlobRef}`；图片/文件走文件传输子系统，聊天里只放引用。房间内 Mesh 广播（发给所有对端）。

### 6.3 屏幕共享
- `getDisplayMedia({video:{...}, audio:true})`；`track.contentHint = "detail"`（保文字清晰，Chromium/Safari 有效）。
- 编码控制：`sender.setParameters()` 调 `maxBitrate`；`degradationPreference = "maintain-resolution"`（运维/看字场景）。
- 编解码：`setCodecPreferences` 按对端能力协商，AV1/VP9 覆盖 Chromium/FF、H.264 兜底。
- **限制**：桌面限定，移动端浏览器无此 API；需 HTTPS。
- **三条分发路径**（按对端连接与房间规模）：① WebRTC 直连/TURN → 原生媒体轨（画质/延迟最好、带音频）；② 已降级为 WS 中继 → `screencodec.ts` 自编码经加密中继（仅视频）；③ 大房间（fanout 层级）→ 自编码经服务器扇出（见 6.7）。后两条都需安全上下文（WebCodecs）。

### 6.4 互动白板（Yjs CRDT）
- 白板文档 = **Yjs Y.Doc**，图元存 `Y.Array`/`Y.Map`；变更通过 control 通道以 Yjs update 二进制同步（自写一个薄 WebRTC provider，或直接手动 `Y.applyUpdate`）。
- 光标/在场 = Yjs Awareness，走 `sync` 无序通道，节流 10–15Hz。
- 渲染：接收端 `<video>` 上叠加 `<canvas>`，白板坐标按视频显示区做归一化映射。
- **注意**：CRDT 文档只增不减（含墓碑），长会话需快照/轮换；图片等大 blob **不入 CRDT**，只存引用。

### 6.5 一起看片房（同步播放游标）
各端播本地副本，`sync` 通道同步游标：
- **时钟同步**：NTP 式四时间戳 `offset = ((t2-t1)+(t3-t4))/2`；维护 8 个样本滑窗，**取最小 RTT 样本**（不做平均，抵抗路径不对称）；前 3 次每秒 ping，之后每 60s。
- **漂移纠正**（照搬 Jellyfin SyncPlay 阈值）：
  - `|diff| < 60ms`：死区，不动。
  - `60ms ~ 400ms`：`playbackRate = 1 + diff/1000`（1s 内追齐后复位 1.0）。
  - `> 400ms`：硬 `seek`。
- **精度目标**：<100ms 体感完美；用 `requestVideoFrameCallback.mediaTime` 测真实显示位置（`currentTime` 非帧精确）。
- **控制**：主控 play/pause/seek 经 control 通道广播，房间内所有人跟随。
- **可选增强**：无本地副本者由主控经 bulk 通道推流（WebCodecs/DataChannel），成本高，后置。

### 6.6 局域网离线快传（无信令服务器）
纯数据通道，不要求安全上下文，故可在 `http://<LAN-IP>` 跑（但摄像头等媒体功能不可用）：
- **信令方式**：① 手输对方 IP + 局域网内临时 WS（若一端能起本地服务）；② **手动复制 SDP / 二维码**（serverless，vanilla ICE）。
- **vanilla ICE**：不配 STUN/TURN，等 `icegatheringstate === "complete"`（`onicecandidate` 收到 null）再导出完整 SDP；离线只有 host candidate，收集快。
- **二维码优化**：SDP 压缩到 55–100 字节（从 DTLS 指纹派生 ICE 凭证、二进制打包候选）。
- **已知坑**：mDNS `.local` 混淆候选依赖组播可达，AP 隔离/跨 VLAN 会静默失败——UI 需给「连接失败请确认同一 Wi-Fi 且未开访客隔离」提示。

### 6.7 大房间媒体扇出（服务器分发端到端加密密文）
房间 > `FANOUT_THRESHOLD`(=8) 时，屏幕/语音从「每对端各发一份」切到「上行一份、服务器复制给所有观众」，消除发送端 O(N) 的上行与编码开销。**不是 SFU**——服务器不解码、不转码，只按房间复制不透明密文。
- **自编码**：屏幕用 `screencodec.ts`（WebCodecs `VideoEncoder`）、语音用 `voicecodec.ts`（WebCodecs `AudioEncoder`，Opus 32kbps 单声道），发送端把媒体自行编成 `EncodedChunk`（就在 JS 手里，绕开浏览器内部 SRTP 栈，故可经服务器转发）。**需安全上下文**——WebCodecs 与 `crypto.subtle` 一样在明文 http 下不存在（如实告知用户，见 6.3 限制）。
- **群密钥（SFrame sender-key 模型，不轮换）**：发送端开播时随机生成 32 字节群密钥，经**每对已加密的 control 通道**用 `media-key` 消息发给各观众（**绝不过服务器明文**）。屏幕与语音复用同一把发送端密钥，帧内 1 字节 `kind` 区分且被 AEAD 鉴权。房间成员皆为授权观众，无需轮换。
- **线格式（外层版本字节=2，区别于 1:1 中继的版本 1）**：发送端→服务器 `[2][inner]`；服务器→观众 `[2][srcIdLen][srcId][inner]`（服务器**在密文外**盖来源 peerId，修历史「语音串号」之踩坑）；`inner = [nonce:12][cipher]`，`cipher = seal(群密钥, nonce, [kind:1] ++ packet)`。
- **服务端**（`src/room.rs::fanout` + `src/ws.rs`）：`relay_binary` 按首字节分流——`1` 走 1:1 中继（`send().await` 背压），`2` 走 `fanout`（`try_send`，满即丢帧，绝不让一个慢观众卡住实时媒体）。服务器只复制密文、看不到明文。
- **客户端枢纽**（`core/fanout.ts` 的 `FanoutHub`）：一端既是发送端（`sendScreen/sendVoice`）也是观众（`handleFrame` 解密后分发给屏幕/语音解码器）。`mesh.ts` 依 `tier` 在「逐对端」与「扇出」间切换路径，跨阈值时原地换路。
- **能力缺口如实告知**：发送端无 WebCodecs 编码器 → 提示无法在大房间扇出该媒体；观众浏览器无 WebCodecs 解码 → 提示收不到（明文 http 常见）。扇出语音无 WebRTC 的回声消除链路。

---

## 七、浏览器兼容矩阵（能力→降级）

| 功能 | Chrome/Edge | Firefox | Safari 桌面 | iOS Safari |
|------|:----------:|:------:|:----------:|:---------:|
| 数据通道/文件传输 | ✅ | ✅ | ✅ | ✅ |
| 流式落盘 (FSA) | ✅ | ❌→OPFS | ❌→OPFS | ❌→OPFS |
| 文件夹上传 | ✅ | ✅ | ✅ | ✅ 18.4+ |
| 屏幕共享 | ✅ | ✅ | ✅ | ❌ 无 |
| 白板 (Canvas+Yjs) | ✅ | ✅ | ✅ | ✅ |
| 看片同步 | ✅ | ✅ | ✅ | ✅ |
| rVFC 帧精确 | ✅ | ✅ 132+ | ✅ | ✅ |
| SAS 指纹校验 | ✅ | ✅ | ✅ | ✅ |
| 局域网 http 直连(仅数据) | ✅ | ✅ | ✅ | ✅ |

---

## 八、部署拓扑

```
[用户浏览器] ──HTTPS──▶ [静态托管: Nginx/Caddy/CDN]  (Web SPA)
             ──WSS───▶ [信令服务器: Rust 二进制]      (可 systemd/容器)
             ──STUN──▶ [coturn (STUN)]
             ──TURN──▶ [coturn (TURN, 3478 UDP/TCP, 5349 TLS, +UDP/443)]
```
- **Web + WSS 必须 HTTPS**（getUserMedia/屏幕共享/SW 依赖安全上下文）。信令与静态可同域反代。
- **coturn** 单机自建最省钱（VPS 含大流量套餐边际成本近零）；监听多端口提升穿透率（很多网络封随机 UDP 但放行 UDP/443、TCP/80）。
- **横向扩展**：WebSocket 天然黏在单连接；多信令节点时按**房间**一致性哈希 + Redis pub/sub 跨节点转发，多数扇出留在本地。单机足够时不引入。

---

## 九、开发路线图

| Phase | 内容 | 关键地基 | 状态 |
|-------|------|---------|------|
| **1a 地基** | Rust 信令服务器 + WSS 客户端 + Perfect Negotiation + 单连接建立 + **文本聊天**打通端到端 | 房间注册表、信令协议、TURN 凭证、SAS 校验 | ✅ 已完成（2026-07-27） |
| **1b 文件** | 单文件 → 文件夹快传，Chromium 流式 / 其他 OPFS，Worker 哈希，背压 | 分块协议、落盘抽象 | ⚠️ 基础版已落地（2026-07-27）：多文件/多目标、独立 file-<id> 通道、64KiB 分块 + 背压、进度/取消；内存 Blob 落盘（≤1GB）。文件夹（zip 打包）与会话内断点续传已补（2026-07-29）；流式落盘(FSA/OPFS)、Worker 哈希、跨会话续传待补 |
| **1c 媒体** | 屏幕共享 + 互动白板（Yjs） | 媒体协商、Canvas 叠加 | ✅ 已落地（2026-07-28）：媒体轨复用既有 PeerConnection + 完美协商；白板未引 Yjs，用「笔画 op + 全量状态合并」轻量同步（见落地记录） |
| **1d 看片** | 一起看片房（时钟同步 + 漂移纠正） | sync 通道、rVFC | ❌ 已裁撤（2026-07-29）：判定为低价值功能，侧边栏占位一并移除 |
| **1e 局域网** | 手输 IP / 二维码 serverless 信令 | vanilla ICE | |
| **2** | 一键剪贴板互传（降级版）、多人 Mesh 打磨 | | ❌ 剪贴板互传已裁撤（2026-07-29）：按钮版体验鸡肋，改为聊天页原生粘贴（文本进输入框、文件/截图直接发送）；Mesh 打磨已随 1a–1c 落地 |
| **3+** | 空间音频挂机房、旧手机监控、P2P CDN | 后续评估 | |

> 建议即便首期范围含 1c/1d，也**先做完 1a 地基**（信令+连接+聊天+SAS）再并行铺开——所有功能都依赖这套连接与传输底座。

### 1a 落地记录（2026-07-27）

- **后端** 单 crate `pphub`（`src/`）：axum 0.8 + tokio，前端经 `rust-embed` 编译期嵌入、同端口托管。CLI 用 clap（`-H/--host` 默认 `0.0.0.0`、`-p/--port` 默认 `8848`）。房间注册表为 `Mutex<HashMap>` + 非阻塞 `try_send`（不跨 await 持锁）；`/ws` 走 WebSocket，`/healthz` 健康检查，其余路径回退到嵌入的前端；`turn.rs` 以 coturn `use-auth-secret` 模式签发 HMAC-SHA1 临时凭证，共享密钥仅存服务端。
- **前端** `web/`：Vue 3 + TS + Vite。`core/` 为与 UI 解耦的 P2P 底座（signaling / peer / mesh / security(SAS) / channels / capabilities）；Pinia store 把 Mesh 事件映射为响应式 UI；`LobbyView` + `RoomView` 打通进房、成员列表、SAS 带外校对、端到端文本聊天。
- **验证**：`vue-tsc` 类型检查 + `vite build` 通过；`web/scripts/smoke-signaling.mjs` 双客户端冒烟测试 10 项全过（joined / peer-join / signal 透传 / peer-left，且 TURN 密钥不外泄）。
- **工具链留坑**：TypeScript 7（Go 原生编译器）移除了 `./lib/tsc` 子路径导出，当前 `vue-tsc@3.3.8` 不兼容，已固定 `typescript@~5.9.3`；待 vue-tsc 支持 TS7 后再升。

### 界面改版 + 1b 基础版落地记录（2026-07-27）

- **UI 全面改版（参考 PP直连）**：浅色主题；左侧功能导航（连接设备 / 发送文件 / 接收文件 / 文本消息，后续 Phase 能力以「规划中」占位）；「大厅→房间」模型改为 **短码直连** 模型。
- **三种直连方式**（复用既有房间机制，后端零改动）：① 6 位临时短码（会话内稳定，短码即房间名；「允许短码连我」= 自动加入自己短码的房间监听）；② 分享链接 `?c=<code>` 打开自动连接；③ 自定义房间口令（≤6 台全网状）。断开自己短码房时自动轮换新短码，避免对端立刻重连导致「断开」失效。
- **文件传输 1b 基础版**：control 通道发 `file-offer` 元信息 → 独立 `file-<id>` 数据通道流式发送（64KiB 分块、bufferedAmount 背压 + 轮询兜底防挂起）→ 排空后关闭；接收端字节数够即成 Blob 自动保存。支持多文件（同对端串行）、多目标（跨对端并行）、双向取消（`file-cancel`）、进度/速率展示。**待补**：流式落盘（FSA/OPFS）、文件夹、Worker 哈希校验、断点续传。
- **剪贴板互传（降级版）**：文本消息页支持一键发送剪贴板内容、逐条复制。
- **验证**：`vue-tsc` + `vite build` 通过；无头 Chromium 双上下文 E2E 全过（短码互连 / SAS 两端一致 / 聊天送达 / 2MB 文件收发完成 / 断开轮换短码回监听）。

### 1c 媒体落地记录（2026-07-28）

- **屏幕共享**：`getDisplayMedia`（video 30fps + 可选系统音频）采集，媒体轨经 `pc.addTrack` 挂到每个对端连接，复用完美协商透明重协商；新入房对端在 `addPeer` 时自动补挂，`screen-start/stop` control 消息驱动 UI 状态（迟到者在 channelopen 时补发）。支持多人同时共享、观看端 Tab 切换、远端声音开关；浏览器原生「停止共享」按钮经 `track.onended` 同步收尾。
- **屏幕控制 = 远程指挥**（纯浏览器边界内）：观看端在画面上用**远程指针 / 点击涟漪 / 透明画笔批注**（PRD 2.1 的"透明画笔"），经 control 通道广播，实时叠加在共享端预览与所有观看端上。完整键鼠注入确认不可行：合成事件 `isTrusted=false`，Captured Surface Control 的 `forwardWheel` 规范明确丢弃非可信事件（"If event.isTrusted is false, abort these steps"），维持「不做原生伴侣程序」的决策（§一）。
- **互动白板**：16:9 逻辑画板（坐标归一化 [0,1]，线宽按逻辑宽 1280 缩放），画笔/橡皮（destination-out）/撤销（按笔画 id）/清空/导出 PNG/成员激光笔光标。**未引入 Yjs**：笔画是只增数据（append-only + 按 id 删除），用 `draw-begin/points/end/remove/clear` op 流 + 新对端 `draw-state` 全量合并（id 去重）即可收敛，省掉 ~20KB 依赖；将来需要协作编辑图元属性时再上 CRDT。
- **协议/架构**：`messages.ts` 新增 `screen-*`、`draw-*`、`ptr-*` kind，绘制消息以 `board` 字段寻址（`wb` = 白板，`screen:<peerId>` = 该对端画面的批注层，共享一套渲染/同步逻辑）；`peer.ts` 暴露 `ontrack/addTrack/removeTrack`；`mesh.ts` 新增 `broadcast/sendTo` 与屏幕共享编排；UI 侧 `DrawLayer.vue`（canvas 重绘 + 指针输入 + 远程光标）与 `DrawToolbar.vue` 为屏幕批注/白板共用。后端信令**零改动**。
- **验证**：`vue-tsc` + `vite build` 通过，`cargo build` 嵌入正常；三端无头 Chromium E2E（`web/scripts/e2e-media.mjs`，getDisplayMedia 注入 canvas 假流、WebRTC 全真实路径）8 项全过：A/B 互连 → A 共享 B 收到 640×360 媒体帧 → B 批注回显到 A → B 远程指针显示在 A → 白板 A→B 实时同步 → 迟到者 C 收到全量 → A 停止共享 B 撤画面。修复一处竞态：DrawLayer 挂载前笔画已同步到达时不会首绘（onMounted 补首绘）。

### 网络视图 + 名片 + 懒发送/多源下载落地记录（2026-07-28）

- **网络视图（NetworkView 取代 ConnectView）**：本机居中、对端环形分布（peerId 排序保证布局稳定），SVG 连边按真实连通性着色（绿=connected / 黄=connecting / 红=failed）。**拓扑数据**：本端→对端直接取 `Peer.connectionState`；对端↔对端经新增 `link-state` control 消息 gossip——每端在任一连接状态变化时向全网广播自己的邻接表，两端上报的同一条边按字典序 key 去重。所有操作内化于视图：点对端节点弹出「私聊 / 发文件 / 共享屏幕给 TA / 私有白板 / 安全核验(SAS)」菜单，点中心节点编辑名片，底部动作条面向全网（群聊/群发/共享屏幕/公共白板）。组网面板（短码/链接/口令）在无对端时展示、组网后折叠为「邀请」按钮。
- **名片（profile.ts）**：昵称 + 头像（emoji+底色 或 96×96 JPEG dataURL ≤24KB，canvas 居中裁切压缩），localStorage 持久化，`rev` 单调递增防乱序覆盖。通道就绪时互发 `profile`，变更即广播；信令 join 的 `nick` 仍带昵称做首屏回退。
- **发文件：单播/广播 × 强制/懒发送**。目标可选「全网广播」或任一节点；模式二选一——**强制发送**沿用原推模型（file-offer + 独立 file-<id> 通道流式推送）；**懒发送**走新的拉模型（swarm.ts）：
  - `share-offer` 只登记 `SharedFileMeta`（fileId/size/chunkSize=64KiB/chunks/owner/scope），**零上传**；通道就绪时 `share-list` 全量同步目录（仅 scope=all）；`share-revoke` 撤销。
  - 下载方广播 `have-req` 做源发现；持有者以 `have`（full 或 base64 位图）应答；调度器按 **rarest-first** 挑块、按源在途数（每源 ≤4）挑源，`chunk-req`/`chunk-nak` + 15s 超时换源重试；分块数据走每对端一条常驻二进制 `swarm` 通道（4 字节小端 reqId + 负载，与 control 分离避免队头阻塞），供块侧按 bufferedAmount 限流（>4MiB 暂缓）。
  - **多源扩散**：下载方每收 32 块广播一次位图、完成后广播 `have full`——拿到片段的节点即刻成为新源，后续下载者自动从多个源并行拉块（E2E 验证 C 从 A+B 两源下载），共享方单点负载随节点数摊薄。
- **聊天频道化**：`chat` 消息新增 `scope: 'all' | 'dm'`；群聊广播、私聊单播（ChatView 左侧频道列表 = 群聊 + 每节点私聊，未读分频道计数，SideNav 汇总）。
- **私有白板**：board id 约定新增 `wb:<a>~<b>`（两端 peerId 字典序拼接）；绘制/指针消息按 board 路由——私板单播给对方，公板广播；新对端通道就绪时补发公板与对应私板的 `draw-state` 全量。屏幕共享新增 scope（`screen-start` 带 scope 字段，direct 只挂媒体轨到指定对端、迟到者不补挂）。
- **验证**：`vue-tsc` + `vite build` + `cargo build` 通过；原 e2e-media.mjs 8 项全过（无回归）；新增 `web/scripts/e2e-network.mjs` 三端 E2E 13 项全过：组网 → 网络视图节点/连边/gossip 边 → 名片同步 → 私聊隔离 → 群聊广播 → 强制单播（C 无泄漏）→ 懒发送登记（零推送）→ B 按需下载（A 供块计数）→ **C 多源下载（2 源）** → 私有白板同步与隔离。后端信令继续**零改动**。

### 中继路径的屏幕共享（WebCodecs）落地记录（2026-07-28）

- **问题**：默认单端口部署下打不通的对端会降级到 WS 应用层中继，此时屏幕共享彻底不可用——WebRTC 媒体轨由浏览器内部 SRTP 栈收发，JS 拿不到编码帧，无法经应用层转发。原实现还会给这类对端照发 `screen-start`，对方于是挂出一个**永远黑屏**的画面条目；发起端即使一个对端都送不到也照样进入「共享中」。
- **绕开媒体轨**：新增 `core/screencodec.ts`，中继路径改用 **WebCodecs 自编码**——`MediaStreamTrackProcessor` 取原始 `VideoFrame` → `VideoEncoder`（候选 `avc1.42E01F` / `vp8` / `vp09`，`latencyMode:'realtime'`，H.264 用 annexb 让每个关键帧自带 SPS/PPS）→ 编码字节走中继 → 对端 `VideoDecoder` → 画布 `captureStream()` 变回 `MediaStream`。**关键收益**：出口仍是 `MediaStream`，接收端的渲染、Tab 切换、批注/远程指针链路一行不用改。参数：≤1600 宽、15fps、1.8Mbps、4s 关键帧，128KiB 分片，编码队列 >2 帧或中继积压 >2MiB 时丢帧。
- **通道与分流**：`relay-transport.ts` 增 `KIND_SCREEN=4`（与 control/file/swarm 并列，同一把会话密钥）；密钥未就绪时屏幕包**直接丢弃而非排队**——实时画面积压只会变成一堆过期帧，等就绪后补一个关键帧即可恢复。`mesh.ts` 按 `peer.transport` 分流：webrtc 走 `addTrack` + `screen-start{via:'track'}`；relay 走编码器 + `screen-start{via:'codec'}`。编码器全局唯一，按 `codecViewers` 扇出同一个 ArrayBuffer（`encryptAndSend` 同步复制后再发，可安全共享）。中途降级的对端由 `transport` 事件触发重新挂载，新观众到达时补一个关键帧。
- **诚实降级**：`screenTargets()` 在开采集器**之前**预检每个对端可达性，一个都没有就不进入共享状态并给出原因；部分可达则照常共享但说明少了谁。对端解不了码时给明确提示而非黑屏条目，`ScreenView` 的共享按钮在不可用时禁用并用 `title` 说明原因。代价说清楚：**无音频**（系统音频轨没有对应的 AudioEncoder 路径）、无拥塞控制、需要安全上下文。
- **验证**：`vue-tsc` + `vite build` + `cargo clippy` 通过；`e2e-relay.mjs` 扩到 13 项全过，新增 4 项覆盖本次改动：预检判定 → B 端解出 640×360 画面 → 画面**持续更新**（比对像素，证明不是只解出首帧）→ 无解码能力的节点只收到提示、不生成黑屏条目 → 停止共享后编解码器一并释放。`e2e-media` / `e2e-network` / 两个 smoke 无回归。修复一处漏判：拒绝黑屏条目的分支把「只提示一次」的去重条件写进了同一个 `if`，导致第二条 `screen-start` 直接落到正常分支——提示要去重，拒绝必须每次都拒。后端**零改动**。

### 明文 http 下的中继加密（纯 JS）落地记录（2026-07-29）

- **问题**：中继加密原用 `crypto.subtle` 的 ECDH(P-256) + AES-GCM，而浏览器只在安全上下文提供 `crypto.subtle`。以明文 http + 局域网 IP 访问时中继无法加密，实现选择**拒绝降级**（不明文转发），后果是这种部署下打不通的对端彻底连不上、SAS 也失效——「只有同网段能互连」。
- **不降级为明文，改让加密始终可用**：实测非安全上下文下 `crypto.getRandomValues` 仍在（被砍的只有 `subtle`），故用审计过的纯 JS 实现替换：X25519（`@noble/curves`）+ HKDF-SHA256 + ChaCha20-Poly1305（`@noble/ciphers`），新增 `core/crypto.ts`。实测 192KiB 帧上 **186 MB/s**，远快于它喂的那条 WebSocket，因此**不按 `crypto.subtle` 是否存在分叉**，统一走一条路径——少一个只在特定环境触发、平时测不到的分支。代价是 gzip 后 +21KB。
- **顺带修正的设计**：收发两个方向各派生一把子密钥（HKDF info 分别为 `pphub-relay-v1|a2b` / `|b2a`，方向由双方公钥字典序决定），nonce 改用**计数器**而非随机数——同一把密钥下 nonce 重用会直接摧毁 AEAD 的安全性，计数器在结构上就排除了这种可能。`computeSas` 随之从 async 变同步（不再 `await subtle.digest`），这也顺手修好了**直连路径**在 http 下拿不到 SAS 的问题。信令的 `relayKey` 从 JWK 变成 base64 公钥字符串；服务器把 `data` 当作不透明 `serde_json::Value`，故后端**零改动**。
- **诚实标注边界**：`peer.ts` 里「加密不可用就拒绝降级」的分支连同 `relayblocked` 事件一并删除——加密不再有不可用的情况。但 `NetworkView` 的横幅必须说清楚它防不住什么：**页面本身经明文 http 传输时，能篡改流量的攻击者可以替换页面脚本，从而绕过页面内的一切加密与核验**。它防的是服务器窥探与链路旁观者，不是主动中间人；浏览器限制 `crypto.subtle` 正是这个道理。
- **验证**：新增 `web/scripts/e2e-http-relay.mjs`，经本机局域网 IP 以明文 http 访问（`127.0.0.1` 不行，那本身算安全上下文——原 `e2e-relay` 全程跑在安全上下文里，证不了这次改动），6 项全过：确认 `crypto.subtle` 确实缺失 → 中继照常建立 → SAS 两端一致 → 聊天/白板/128KiB 文件送达 → 钩住 `WebSocket.send` 检查出站字节**不含明文**（带阴性对照，避免探测函数失效导致空过）→ 屏幕共享如实标为不可用。原五套件（含 `e2e-relay` 13 项）+ `cargo clippy` 无回归。

### 通告对端解码能力（混合上下文屏幕共享）落地记录（2026-07-29）

- **问题**：真实部署（nginx 同开 http/https，两端各走一个）暴露出来的——https 端共享屏幕，http 端弹「正经中继共享屏幕，但当前浏览器不支持 WebCodecs 解码，无法观看」，而发起端显示「共享中」，一切正常。根因是可达性判据只问「**我**能编码吗」，从不问「**对方**能解码吗」：`canDecodeScreen()` 只在接收端本地调用，对端能力从未上过线。
- **诊断要点**：那句提示只在收到 `screen-start{via:'codec'}` 时触发，而 `via:'codec'` 仅出现在**中继**路径。所以症结不是「http 端看不了共享」，而是「**中继路径**的共享 http 端看不了」——走直连/TURN 时发的是 `via:'track'`，用原生媒体轨，接收端不需要 WebCodecs。对用户而言真正的解法是开 `--stun-turn` 把连接挪回 ICE 层，本次改动解决的是「状态显示不准」。
- **通告**：`Profile` 增可选字段 `screenDecode`。**在 mesh 的发送口统一注入**（`outgoingProfile()`），而不是让 store 填——它是运行环境属性，UI 层不必关心；实时探测也避免了持久化进 localStorage 后带着过期值跑到别的环境。缺省 `?? true` 兼容不带该字段的旧版本，真解不了时接收端仍有兜底。
- **消费**：`screenTargets()` 三分支改为「webrtc 直接放行 → 本端不能编码 → 对端不能解码」，各自给出不同原因。`attachScreen()` 同样加了这道闸——预检是建议性的，中途才降级到中继的对端只会走到这里。名片通常在 `channelopen` **之后**才到，故 `case 'profile'` 里比较前后值：若从「默认可解码」翻转为不可解码，撤掉已登记的 `codecViewers` 并提示，避免白烧一路编码。
- **踩坑**：改完 `screenTargets()` 后测试仍报 `ok:1`。加诊断脚本确认 `screenDecode:false` **确实送达**了对端，问题在消费侧——`store.screenReach` 是**另一处独立实现**的同一套判据（注释还写着「与 mesh.screenTargets 同一套判据」），只改 mesh 漏了它。这正是判据重复实现会漂移的典型。两处已对齐，注释写明缺省语义。
- **验证**：`e2e-mixed-context.mjs` 中原本固定「已知缺口」的那条断言翻转为正确行为——预检判定 0/1、`startShare` 返回 false 不进入共享状态、对端不留黑屏条目，7 项全过。其余六套件（smoke ×2 + e2e-media/network/relay/http-relay，共 60 项断言）无回归。后端**零改动**。

### 短码防撞：服务端所有权 + 动态码长落地记录（2026-07-29）

- **问题**：短码由客户端纯随机生成（6 位数字），无任何唯一性保证。按生日碰撞估算，同时监听数达 1000 时撞码概率约 39%。且撞码的后果不是「连不上」而是**两个陌生监听者被静默连进同一房间**——互见名片、可互发消息文件，是隐私问题。
- **不采用纯客户端自检**（进房发现已有人就换码）：它无法区分「撞码的监听者」与「先我一步进房等待的拨入方」，会误伤离线分享链接（`?c=` 指向我的短码、对方先进房等我上线）这一已支持的流程。
- **服务端所有权**：`join` 增 `#[serde(default)] listen: bool`——监听者带此标志声明对短码房的所有权（`Room.owner`），已有其他监听者时拒绝（新错误码 `code-taken`）；拨入方不受限，可先进空房等待。owner 随监听者离开清空，空房销毁。旧客户端不带该字段 ⇒ serde 缺省 false ⇒ 行为同旧版，线格式向后兼容。
- **动态码长**：`joined` 应答增 `code_len`，按当前房间数推荐（10^len ≥ 10⁴ × 房间数，即新监听者撞码概率 < 10⁻⁴：<100 房 6 位、<1000 房 7 位……9 位封顶）。客户端记入 sessionStorage，后续 `regenCode` 按此长度生成；监听成功但码短于建议且**房里没人**时主动升长换码（有人连着时绝不换，避免把对端甩掉）。生成改为按字节拒绝采样（≥250 丢弃）的无偏数字串，替换原 `Uint32 % 10^6`。
- **客户端编排**：`mesh.join()` 从「发完 join 即返回」改为**等待服务端应答**——`joined` 兑现（附已有成员数与 `codeLen`），join 阶段错误以 `JoinRejected(code)` 驳回；`status='online'` 从此才是真的在房里。store 的 `listen()` 收到 `code-taken` 自动换码重试（上限 3 次，升长不计入）；刷新恢复走 `listen()` 以重新声明所有权，而非裸 `joinRoom`。
- **验证**：Node 直连 WS 协议测试 8 项（撞码拒绝 / 拨入放行 / 拨入方先到监听者后到可进 / owner 释放后短码可复用 / 旧格式兼容）+ 码长升降级（105 房 → 7 位，清空 → 6 位）+ 无头 Chromium 双标签页注入同一短码的端到端测试 6 项（先到者保码、后到者自动换码、拨入连到先到者）全过；`cargo check` + `vue-tsc` + `vite build` 通过。

### 十项功能批量落地记录（2026-07-29）

一次落地十项能力，全部构建在既有 control 通道 / 媒体轨 / swarm 底座上，后端信令**零改动**。

- **拖拽发送**：聊天窗整窗拖放（scope 跟随当前频道）、网络视图**拖到节点头像直发 TA**（悬停高亮）、发送页拖放升级。统一入口 `utils/fs.ts::collectDropped`——用 `webkitGetAsEntry` 递归遍历目录（readEntries 每批 100 条循环读尽），把一次 drop 整理成「零散文件 + 顶层文件夹」。
- **文件夹传输**：不逐文件传目录结构（接收端浏览器没有可靠的按路径落盘能力），改为 `utils/zip.ts` 打包 **store 模式 zip**——Blob 由「头部字节 + File 引用 + 目录字节」拼成，File 部分是惰性引用不进内存，只有 CRC32 需要顺序读一遍；UTF-8 文件名（bit11）；不做 zip64，超 4GB/65535 条目**诚实拒绝**而非产出损坏包。`<input webkitdirectory>` 与拖拽两条入口共用 `store.dispatchPayload`。
- **断点续传（会话内）**：swarm 的 `Download.dropSource` 在所有源掉线时不再作废下载，保留已到手分块进入**停摆**（UI 呈现「等待源恢复自动续传」，可手动取消）；mesh 在任一对端 `channelopen`（重连/中继降级后重开）时对所有进行中下载补发 `have-req`，源恢复即自动续传；下载中的共享条目不随 share-revoke / 持有者离开作废。边界：共享登记是会话态（刷新即焚），源的**页面**关掉重开需对方重新共享——跨会话续传（IndexedDB 持久化分块）留待后续。
- **图片消息内联预览**：`shareFiles` 对图片生成 ≤320px JPEG 缩略图（`utils/blob.ts::makeImageThumb`，>64KB 不值得随元信息广播则放弃），随 `SharedFileMeta.thumb` 广播；聊天气泡直接显示缩略图，点击开灯箱——已下载/下载完成自动无缝换原图，未下载给「下载原图」按钮（多源下载链路复用）。接收页共享列表同样显示缩略图。
- **二维码连接**：`uqr`（gzip 后 ~4KB）把分享链接渲染成 SVG 内嵌组网面板，手机扫码打开 `?c=` 即连，解决跨设备输码。
- **后台消息通知**：`utils/notify.ts`——页面不可见时来消息（文本/文件/语音）发 Web Notification（点击聚焦回页）+ **标题闪烁**兜底，回到页面自动复原；权限在「连接」这个用户手势里申请（Safari 强制），未授权仍有标题闪烁。
- **消息表情回应**：`chat` 消息补 `msgId`（全网唯一），`react` 消息按 msgId 寻址（add/remove，按频道单播/广播）；气泡悬停出 6 个 emoji 快捷条，回应以 chips 聚合展示（悬停见回应者，再点撤销）。
- **语音消息**：按住麦克风录音（MediaRecorder，opus 32kbps，60s 上限自动截断），base64 经 control 通道直达。**关键坑**：单条 control 消息受 SCTP `maxMessageSize` 约束（跨浏览器保守 ~256KB），长录音按 48K 字符分片（`voice-note` 增可选 `part/parts`），接收端按 msgId 重组——control 有序可靠，分片天然按序。松开发送、上滑无、<0.4s 丢弃；播放为自绘气泡（同时只播一条）。
- **实时对讲（push-to-talk）**：侧边栏「按住说话」，麦克风轨 `pc.addTrack` 复用完美协商链路（同屏幕共享），`voice-start{streamId}` 先行通告让对端把到达的媒体流与屏幕共享区分开（兜底：纯音频流即语音）；迟到/重连对端在 channelopen 补挂。**中继路径收不到**（媒体轨过不了应用层中继，未做音频自编码）——开麦时如实列出听不到的节点并指向语音消息兜底。说话中的节点在网络视图头像上有呼吸麦克风徽标。
- **连线延迟显示**：mesh 每 5s 向各对端发 `ping{seq}`，`pong` 回来算 RTT；`link-state` gossip 邻接表附带实测 RTT 并周期重播（15s），网络视图在**每条连通边的中点**标注毫秒数（HTML 定位而非 SVG text，避开 `preserveAspectRatio="none"` 的文字拉伸；≥150ms 转警示色）。
- **你画我猜**：公共白板叠加游戏模式，谜底**只在出题人本地**（`guess-start` 只广播提示），`guess-try` 全网可见，出题人归一化比对自动裁决（也可手动判对），`guess-correct` 携带全量比分（胜者 +2 出题 +1）防漂移；猜词回合非出题人画笔锁定只留激光笔，内置 80 词随机抽三 + 自拟词。
- **五子棋**：私聊内邀请（`gomoku-invite/accept/decline`，撤回复用 decline），邀请方执黑；两端镜像棋盘各自校验（手数 n 连续、轮次、占位），非法落子直接忽略；连五/棋满/认输/对方离线四种终局。SVG 棋盘弹层，最后一手红点、胜形高亮。
- **游戏入口（后补）**：初版入口藏得深（五子棋在私聊标题栏、你画我猜在白板标题栏），补充网络视图两处显眼入口——节点菜单「五子棋对局」（切私聊 + 发邀请/续局）、全网动作条「你画我猜」（直达公共白板并弹出出题面板；标志用「挂载时与变化时都消费」的模式，规避 v-if 视图晚于置位挂载而错过 watch 的时序坑）。
- **粘贴/拖入改为确认后发送（后补，按用户反馈定型）**：聊天页的文件三入口（粘贴 / 选择 / 拖拽）统一先挂到输入框上方的**待发区**（图片即时缩略预览、可逐个移除、切频道自动清空），回车或点「发送」才真正发出——文件夹此时才打包 zip，防误发也给了反悔的机会。粘贴的文件从 `clipboardData.items`（getAsFile）与 `files` 两处收齐——部分复制来源只填 items 不填 files，旧写法会静默漏掉。纯文本粘贴仍进输入框可编辑。
- **成员退出清未读（后补）**：私聊频道随成员消失，攒着的未读角标没有入口可清、会永远赖在导航上——`peer-removed` 时一并 `unread.delete(peerId)`，消息历史保留。名片编辑弹层回车即保存并关闭（Esc 直接关闭）。
- **协议/架构**：`messages.ts` 的预留 kind 全部启用（react / voice-note / ping / pong / voice-start / voice-stop / guess-* / gomoku-*），mesh 只做传输与重组、对局与游戏状态全在 store（`GameMessage` 子集事件上抛）；新增 `GomokuPanel.vue`，`utils/` 增 notify / zip / fs / gomoku / words。
- **验证**：`vue-tsc` + `vite build` + `cargo build` 通过；新增 `web/scripts/e2e-features.mjs` 三端 E2E **23 项全过**：粘贴入待发区（未确认对端收不到）→ 确认发送送达 → 回应加/撤同步 → 200KB 语音分片重组字节一致 → RTT 实测/gossip/视图标注 → 两处游戏入口 → 五子棋全流程（含非法落子拒绝）→ 你画我猜全流程（错猜不计分、标点容忍、比分同步）→ 文件夹 zip 结构校验 → 唯一源掉线停摆保留 + 可取消 → 成员退出清未读且历史保留。原七套件（smoke ×2 + e2e-media/network/relay/http-relay/mixed-context，60+ 断言）无回归。

---

### 拓扑语音串号修复 + 游戏桌大厅/邀请 + 象棋/斗地主落地记录（2026-07-31）

围绕「昨天拓扑优化后的语音串号 / 大厅邀请不可用 / 象棋斗地主玩不了」三件事收口，后端信令零改动。

- **语音串号（拓扑）**：昨天的分层拓扑把 `broadcast/sendTo` 改成经组长中继转发，`handleRelayForward` 同组投递时直接把 `payload` 塞给了目标端，绕过了「按 `finalTo === myId` 分支解包、还原 `originalFrom`」的路径——收方拿到的是**中继者**的身份，于是「A 发语音，B 看到是 C 发的」。本项目房间恒 ≤6 人且连接始终全网维持，中继本无收益，遂把 `broadcast/sendTo` 收敛回**直连投递**（`mesh.ts`：遍历 `peers` 直发 / `peers.get(id)?.sendControl`），`handleRelayForward` 同组分支改走 `sendControl(msg)` 让收方正常解包。发送者身份不再被改写。e2e-network/relay 各 13 项无回归。
- **游戏桌邀请流程**：`InviteManager` 是发送端的本地态，被邀请端的 `inviteManager` 里**根本没有**这条邀请（邀请由对端 `createInvite` 生成，只随 `invite-send` 进了收端的 `pendingInvites` 响应式数组）。原 `acceptInvite` 却查 `inviteManager.acceptInvite`→恒 `null`→「邀请已过期或无效」。改为**以 `pendingInvites` 为权威来源**：accept 校验存在性/过期后先出列再通知对端并按桌号入桌（被邀方跳过密码，因远端桌注册无 `passwordHash`）；decline 同理。`invite-send` 处理补去重（同 `from+tableId` 只留最新、已在该桌则忽略）。
- **快速匹配抢桌竞态**：双方几乎同时匹配时会互发 `match-request` 又各自建桌、互发 `match-found`，结果两人加入了**对方不同的**桌子而碰不到一起。用 id 字典序做确定性仲裁——仅较小 id 一方担任桌主发 `match-found`，另一方静待加入。大厅匹配状态改以 `store.myMatchingGame` 为准（`computed`），修掉本地 `matching` ref 与 store 超时/取消不同步导致的遮罩卡死。
- **邀请通知 UI**：`InviteNotification` 改 `TransitionGroup` 堆叠展示多条邀请（≤3），内置每秒时钟过滤已过期邀请使其自动消失。
- **象棋走子**：`XiangqiGame.vue` 棋子层设 `pointer-events:none`、另加覆盖整格的**透明命中层**（每交叉点一块 `rect`，偏移 -CELL/2），空目标格点击也能触发 `clickBoard`（原先只有棋子本身可点，落子到空格无反应）；补 `watch(store.gameStates)` 以 `history.length` 为进度判据消费对端走法（缺它对手走子永不显示、整局卡死），`myTurn` 追加 `table.state==='playing'` 约束。
- **斗地主（从零可玩）**：原本只有 `utils/doudizhu.ts` 的牌型逻辑、无组件（画面全空）。补纯函数 `placeBid/playCards/passTurn/isLegalPlay` 并引入单调 `moveCount`（过牌不改变牌数，牌数无法作对端进度判据，故所有状态转移 +1）；新增 `DoudizhuGame.vue`——桌主开局 `initDoudizhu` 发牌并广播全量状态，各端按 `table.players` 下标定座、以 `moveCount` 判新旧消费广播；只亮自己手牌、其余显背面计数，叫分/出牌/不出按钮受 `isLegalPlay` 约束。`GameTable.vue` 注册 `doudizhu` 分支。
- **验证**：`npm run build`（vue-tsc + vite）+ `cargo build` 通过；e2e-features 23 / e2e-network 13 / e2e-relay 13 全过，无回归。斗地主/象棋桌内联机流程为手工逻辑校验（现有 e2e 未覆盖游戏桌路径）。

---

### QQ 风格大厅 + 匹配遮罩 + 斗地主随机化 + 桌子生命周期落地记录（2026-07-31）

在上一条基础上，围绕五点体验诉求收口，后端零改动：

- **斗地主不共享指针**：指针共享原是游戏无关的全局行为，会泄露手牌类游戏的操作意图。`GameMeta` 增字段 `shareCursor`（棋类/画图 `true`、斗地主/单机 `false`），`GameTable.vue` 的 `handleMouseMove` 与 `remotePointers` 依 `gameMeta.shareCursor` 短路。
- **斗地主随机化 + 再来一局**：座位与叫地主顺序原先固定（`players.indexOf` + 恒从 0 号叫分）。把座位映射搬进 `DoudizhuState.seats`（随广播下发，各端一致），`initDoudizhu` 用 Fisher-Yates `shuffle` 定座 + 随机 `firstBidder`；`placeBid` 计票改数「已定义项」（稀疏 bids 数组下 `bids.length===3` 会误判），并从 `firstBidder` 起循环 tie-break 选地主。终局桌主可「再来一局」——用 `initDoudizhu(players, moveCount+1)` 播种，`moveCount` 递增让各端接受新局覆盖旧终局。
- **大厅改版（QQ 风格）**：`GameLobby.vue` 重写——公开桌绘成真实牌桌图形（椭圆绒面 + 绕桌均布座位，`seatStyle` 按 `π/2 + i·2π/n` 定位，头像/桌主皇冠/可入座空位），创建对话框游戏选择改**下拉 `<select>` + 选中预览**，顶部加游戏筛选标签（全部 / 各游戏带计数）与空状态。
- **快速匹配（MOBA/三国杀 风格）**：新增全局 `MatchmakingOverlay.vue`，以 `store.myMatchingGame` 为开关全屏覆盖（含建桌后自动进等待房的场景），呈现雷达搜索动画、已用时钟、座位逐个填充进度；坐满短暂显示「匹配成功」后清匹配态揭开牌桌。`App.vue` 挂载。
- **邀请/通知重构**：`store.showNotice` 轻量 toast（`App.vue` 底部居中）在发起/被接受时给正反馈；`SideNav` 游戏大厅项挂 `pendingInviteCount` 角标（告诉用户去哪看）；`GameLobby` 顶部常驻**待处理邀请面板**（接受/拒绝内联），与右上角浮动 `InviteNotification` 互补，解决「不知道通知在哪」。
- **桌子生命周期**：`table-manager`/`invite-manager` 补 `reset()`；`teardown` 换房/断连时广播离桌并清空 `gameTables/currentTableId/pendingInvites` 等 + 两 manager reset；`peer-removed` 移除该 peer 于各桌（桌主离场转移、空桌销毁、清相关邀请），修掉「换房后旧桌常驻」。`AppIcon` 补齐 `plus/hash/zap/log-in/eye/globe/lock/mail/gamepad-2` 等此前渲染为空的图标。
- **验证**：`npm run build` + `cargo build` 通过；e2e-features 23 项全过无回归（大厅/匹配/斗地主随机化为 UI 与纯逻辑改动，现有 e2e 未覆盖游戏桌联机路径）。

---

### 大厅快速匹配/筛选/观战 + 邀请送达 & 象棋开局同步修复落地记录（2026-07-31）

针对「邀请对方收不到通知 / 象棋协商卡住无法开始 / 大厅目录过大且与创建按钮重复 / 缺桌子筛选与满员观战」四点收口，后端信令零改动。**并首次以 e2e 覆盖游戏桌联机路径**（此前落地记录中反复标注的空白）。

- **邀请与象棋协商同源的根因（一个 switch 漏 case）**：`mesh.ts` 的 `handleControl()` 用**显式 case 列表**把入站控制消息重新 `emit('game')` 交给 `store.handleGame`，且**无 `default` 分支**——凡未列入的 kind 被静默吞掉。`invite-send / invite-accept / invite-decline` 与 `game-config-propose / game-config-accept` 五个 kind **从未列入**，于是：邀请报文到不了被邀端（`pendingInvites` 永不填充，「只能进大厅看等待桌」正是此症），象棋开局提议/接受也永不同步（`config.agreed` 卡在 false，桌主无从开始）。而 `table-create` **在**列表里，所以桌子能广播可见——「桌见得到、邀请收不到」的表象由此对上。补齐这五个 case 后两条链路一起打通。
- **被邀方入桌的第二个隐性坑**：`table-manager.registerRemoteTable(id, number)` 只登记 号→id 映射（`tableNumbers/usedNumbers`），**不落 `this.tables` 对象**，故 `getTableByNumber` 对远端桌恒 `null`，`joinGameTableByNumber` 报「桌号不存在」。两处兜底：①`acceptInvite` 改为**直接按 `invite.tableId` 入桌**（邀请自带 tableId，被邀方跳过密码），仅在极少见未同步时回退桌号；②`joinGameTableByNumber` 在 TableManager 查不到时**回退到 `gameTables` 按 `tableNumber` 匹配**。
- **大厅改版（去重复 + 快速匹配前置）**：`GameLobby.vue` 把原先硕大、与右上角「创建游戏桌」职能重复的 `.games-catalog` 方阵，换成紧凑的**快速匹配条** `.quick-match`——每款游戏一枚 chip（图标/名称/人数/CTA）：单机点「开始」直接建桌，多人点「匹配」走 `store.startMatching`（触发 MOBA 风格 `MatchmakingOverlay`）；匹配中禁用。创建入口只保留右上角一处。
- **筛选 + 满员观战**：桌列表头新增 `.search-box`（按桌号 `tableNumber.includes` 过滤，数字输入 + 一键清除）、`.status-tabs`（全部 / 等待中 / 游戏中，`all` 排除 `finished`）、及原有游戏类型 `.filter-tabs`。页脚按状态给动作：可入座→「加入」；已满或进行中且允许观战→「进入观战 / 满员 · 观战」（`canSpectateTable` → `store.joinGameTable(id, true)`）；否则禁用。空状态文案区分「有筛选」与「真无桌」。
- **e2e 首次覆盖游戏桌联机（e2e-features 新增 6 项）**：A 建象棋公开桌→B 全网可见；A 邀请 B→**B 端 `pendingInvites` 出现**（正是回归 mesh 漏 case 的哨兵）；B 接受→A 端玩家数同步为 2；A 提议开局→B 收到 `config.proposal`；B 接受→双方 `config.agreed===true`；桌主开始→双方 `state==='playing'`。用例末尾双方 `leaveGameTable` 清理，不污染后续。
- **验证**：`npm run build`（vue-tsc + vite）+ `cargo build` 通过；e2e-features **29 项**（23→29）全过、e2e-network 13 / e2e-relay 13 无回归。踩坑清单：①控制消息 switch 必须有 `default`（或补全 case）否则新 kind 静默丢弃——这是本轮两个功能故障的共同根因；②远端桌不进 `tables`，凡「按桌号找桌」的路径都要有 `gameTables` 回退；③被邀入桌一律走 tableId，不依赖桌号解析。

---

### 自适应组网 + 大房间媒体扇出（路线乙）落地记录（2026-08-03）

把媒体分发从「≤6 人纯网状、大房间无解」推进到**按房间人数自适应**：数据恒全网状 P2P，媒体在大房间由服务器扇出端到端加密密文，屏幕/语音得以发给几十人。**取代**此前 §六/§5.2 中「硬上限 6」「中继路径未做音频自编码、收不到语音」等描述，以及 2026-07-31「拓扑语音串号修复」里「本项目房间恒 ≤6 人、中继无收益」的前提。

- **为何不是 SFU**：真 SFU 要解 SRTP、按订阅转发 RTP，需 https 且不友好于 nginx 的 http/ws 反代，也与「服务器看不到明文」相悖。路线乙让发送端用 WebCodecs 自编码、群密钥自加密后**只上行一份密文**，服务器（`Rooms::fanout`）**只按房间复制密文**——单二进制、可过 nginx http/ws、端到端加密不破。代价：无 SFU 的按需码率/丢包自适应，且需安全上下文（WebCodecs）。
- **层级客户端自决，服务端零协议改动**：`tier = 成员数(含己) > FANOUT_THRESHOLD(8) ? 'fanout' : 'mesh'`。各端成员视图一致 → 判定一致，无需协商。服务端只新增一个**与层级无关**的扇出原语（外层版本字节=2），任何时候都能用。
- **只有媒体切扇出，数据永远全网状**：control/chat/file/whiteboard/game 的 P2P 直发在任何规模都不变——扇出只服务屏幕/语音这种 O(N) 上行的重流量。
- **群密钥（SFrame sender-key，不轮换）**：发送端随机 32 字节密钥，经每对 P2P control 通道以 `media-key` 分发（**绝不过服务器明文**）；屏幕/语音复用同一把，帧内 `kind` 字节被 AEAD 鉴权区分。`crypto.ts` 补 `randomBytes`（`getRandomValues`，明文 http 也可用）。
- **来源在密文外盖章，根治历史「语音串号」**：服务器转发时在 `inner` 外层前缀 `srcId`（`[2][srcIdLen][srcId][inner]`），观众按此认发送端；密文内不含身份，故转发者无从篡改——正是 7-31 分层中继踩过的坑，这次从线格式上排除。
- **背压策略分道**：1:1 中继（版本 1）用 `send().await` 保可靠；扇出（版本 2）用 `try_send`，队列满即丢帧——实时媒体宁可掉帧也不让一个慢观众把整条扇出卡死。
- **中途换路**：跨阈值时 `detach*Paths()`（不停源、不发 stop）+ `apply*()`（按新路径重挂并广播新的 `screen-start/voice-start` via），接受一次短暂闪断（阈值抖动罕见）。原生媒体轨到达时丢弃对应的中继/扇出解码器（新流取而代之）。
- **新增/改动**：`core/fanout.ts`（`FanoutHub`：群密钥、`sendScreen/sendVoice`、`handleFrame`、`isFanoutFrame`）、`core/voicecodec.ts`（`VoiceEncoder/VoiceDecoder`，Opus，镜像 screencodec）、`core/crypto.ts`（`randomBytes`）；`core/mesh.ts`（`MeshTier`、`FANOUT_THRESHOLD`、`reevaluateTier/onTierChanged`、screen/voice 的 apply/detach/emit 分路、`media-key` 分发与登记）；`core/messages.ts`（`screen-start.via` 增 `'fanout'`、`voice-start.via`、`media-key`）；`src/room.rs`（`fanout()` + `max_peers()`）、`src/ws.rs`（`relay_binary` 按首字节 1/2 分流）、`src/config.rs`（`max_peers` 默认 32）。
- **删除的过时代码/文档**：mesh/messages 里的分层拓扑（分组/组长/`relay-forward`）约 ~1500 行连同其死代码文件一并移除；文档内「≤6 人 Mesh 上限」「中继路径未做音频自编码」等描述随本次更新到自适应模型。
- **验证**：`npm --prefix web run build`（vue-tsc + vite）通过；`cargo build` 通过；e2e 见下（媒体扇出的多端联机走无头 Chromium 的既有 e2e 框架尽力覆盖）。

---

## 十、关键风险与技术债

1. **TURN 带宽成本 vs「零带宽」定位**：约 17%（移动 30–40%）连接必须中继，产生真实流量费。需在文档/UI 诚实说明「零带宽」是 P2P 直连时成立。自建 coturn 控制成本。
2. **「E2EE」宣称**：不做 SAS 校验就只是「传输加密 + 信令可 MITM」。SAS 校验必须在 Phase 1 落地，否则不应对外宣称端到端加密。
3. **局域网直连脆弱**：mDNS 组播 + 访客隔离会静默失败；http 局域网 IP 下屏幕共享等媒体功能不可用（连通性本身不受影响，中继与 SAS 已改用纯 JS 加密）——需清晰的错误引导，避免用户困惑。此外，明文 http 下页面脚本可被在途篡改，页面内加密防不住主动中间人，横幅须如实说明。
4. **Safari/iOS 文件落盘**：无 FSA、无 SW 流式下载、无可转移流，大文件只能 OPFS 暂存后导出，且有 7 天 ITP 清除风险；iOS 内存约 1–1.5GB 会被杀进程——大文件在 iOS 上需限制或分卷。
5. **CRDT 文档膨胀**：白板长会话只增不减，需快照/轮换策略。
6. **主线程瓶颈**：WebRTC 栈锁死主线程，重活必须进 Worker，否则大文件传输时 UI 卡顿。
