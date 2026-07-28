# pphub 系统技术架构文档

> 版本 v1.0 · 2026-07-27 · 基于 [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) 已确认的范围
>
> **定位**：跨平台、免安装、端到端（P2P）的隐私互联 Web 应用。除信令协商外，任何业务数据不经云端服务器；全链路默认加密（DTLS-SRTP / DTLS-SCTP）。

## 已确认的范围约束（架构前提）

1. **纯浏览器**，不做原生伴侣程序 → 无远程桌面控制、无 SSH 终端、无局域网自动发现。
2. **信令栈用 Rust**（axum + tokio），单一后端二进制。
3. **纯 P2P Mesh，房间 ≤6 人**，不引入 SFU。
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

**四类流量**：① 应用静态资源（HTTPS，一次性）；② 信令（WSS，小且短）；③ NAT 穿透探测（STUN 无带宽成本 / TURN 有）；④ 全部业务数据走 P2P，端到端加密。**只有 TURN 兜底时**业务数据才过服务器（且服务器仍看不到明文）。

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
    ├── REQ_PRD.md
    ├── FEATURE_INVENTORY.md
    └── ARCHITECTURE.md        # 本文
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
- **房间上限**：服务端强制 ≤6 人（Mesh 约束），满员拒绝并回 `error`。

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
│  mesh.ts       Mesh 拓扑 / 成员生命周期        │
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

### 5.2 连接层 — Mesh 管理
- 房间内 N 人 → 每端维护 N-1 条 `RTCPeerConnection`（全网状）。
- 由信令的 `peer-join`/`peer-left` 驱动增删连接。
- **硬上限 6**；数据通道 Mesh 本可到 50–100 端，但音视频受编码器限制，统一按 6 封顶。

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
- 纯 P2P（无 SFU）下这是可达的真端到端加密。

### 5.5 能力探测与降级
`capabilities.ts` 启动时探测并写入 store，各功能据此启用/降级：

| 能力 | 缺失时降级 |
|------|-----------|
| `showSaveFilePicker`（仅 Chromium） | Safari/FF → OPFS 暂存后 `<a download>` 导出 |
| `getDisplayMedia`（桌面限定） | 移动端隐藏「屏幕共享」入口 |
| 安全上下文（HTTPS/localhost） | http 局域网 IP → 禁用摄像头/屏幕/剪贴板，仅留数据通道 |
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
| **1b 文件** | 单文件 → 文件夹快传，Chromium 流式 / 其他 OPFS，Worker 哈希，背压 | 分块协议、落盘抽象 | ⚠️ 基础版已落地（2026-07-27）：多文件/多目标、独立 file-<id> 通道、64KiB 分块 + 背压、进度/取消；内存 Blob 落盘（≤1GB）。流式落盘(FSA/OPFS)、文件夹、Worker 哈希待补 |
| **1c 媒体** | 屏幕共享 + 互动白板（Yjs） | 媒体协商、Canvas 叠加 | ✅ 已落地（2026-07-28）：媒体轨复用既有 PeerConnection + 完美协商；白板未引 Yjs，用「笔画 op + 全量状态合并」轻量同步（见落地记录） |
| **1d 看片** | 一起看片房（时钟同步 + 漂移纠正） | sync 通道、rVFC | |
| **1e 局域网** | 手输 IP / 二维码 serverless 信令 | vanilla ICE | |
| **2** | 一键剪贴板互传（降级版）、多人 Mesh 打磨 | | |
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
- **通道与分流**：`relay-transport.ts` 增 `KIND_SCREEN=4`（与 control/file/swarm 并列，同一把 AES-GCM 密钥）；密钥未就绪时屏幕包**直接丢弃而非排队**——实时画面积压只会变成一堆过期帧，等就绪后补一个关键帧即可恢复。`mesh.ts` 按 `peer.transport` 分流：webrtc 走 `addTrack` + `screen-start{via:'track'}`；relay 走编码器 + `screen-start{via:'codec'}`。编码器全局唯一，按 `codecViewers` 扇出同一个 ArrayBuffer（`encryptAndSend` 在首个 await 前同步复制，可安全共享）。中途降级的对端由 `transport` 事件触发重新挂载，新观众到达时补一个关键帧。
- **诚实降级**：`screenTargets()` 在开采集器**之前**预检每个对端可达性，一个都没有就不进入共享状态并给出原因；部分可达则照常共享但说明少了谁。对端解不了码时给明确提示而非黑屏条目，`ScreenView` 的共享按钮在不可用时禁用并用 `title` 说明原因。代价说清楚：**无音频**（系统音频轨没有对应的 AudioEncoder 路径）、无拥塞控制、需要安全上下文。
- **验证**：`vue-tsc` + `vite build` + `cargo clippy` 通过；`e2e-relay.mjs` 扩到 13 项全过，新增 4 项覆盖本次改动：预检判定 → B 端解出 640×360 画面 → 画面**持续更新**（比对像素，证明不是只解出首帧）→ 无解码能力的节点只收到提示、不生成黑屏条目 → 停止共享后编解码器一并释放。`e2e-media` / `e2e-network` / 两个 smoke 无回归。修复一处漏判：拒绝黑屏条目的分支把「只提示一次」的去重条件写进了同一个 `if`，导致第二条 `screen-start` 直接落到正常分支——提示要去重，拒绝必须每次都拒。后端**零改动**。

---

## 十、关键风险与技术债

1. **TURN 带宽成本 vs「零带宽」定位**：约 17%（移动 30–40%）连接必须中继，产生真实流量费。需在文档/UI 诚实说明「零带宽」是 P2P 直连时成立。自建 coturn 控制成本。
2. **「E2EE」宣称**：不做 SAS 校验就只是「传输加密 + 信令可 MITM」。SAS 校验必须在 Phase 1 落地，否则不应对外宣称端到端加密。
3. **局域网直连脆弱**：mDNS 组播 + 访客隔离会静默失败；http 局域网 IP 下媒体功能不可用——需清晰的错误引导，避免用户困惑。
4. **Safari/iOS 文件落盘**：无 FSA、无 SW 流式下载、无可转移流，大文件只能 OPFS 暂存后导出，且有 7 天 ITP 清除风险；iOS 内存约 1–1.5GB 会被杀进程——大文件在 iOS 上需限制或分卷。
5. **CRDT 文档膨胀**：白板长会话只增不减，需快照/轮换策略。
6. **主线程瓶颈**：WebRTC 栈锁死主线程，重活必须进 Worker，否则大文件传输时 UI 卡顿。
