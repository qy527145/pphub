# pphub web（前端）

免安装、纯浏览器的 P2P 直连协作应用前端。Vue 3 + TypeScript + Vite。

## 目录结构

```
src/
  core/               P2P 基础设施（与 UI 无关，可单独复用）
    protocol.ts       与 Rust 信令服务器一一对应的线格式
    emitter.ts        极简类型化事件发射器
    signaling.ts      信令 WebSocket 客户端（自动重连 + 领取 TURN 凭证）
    peer.ts           单个 RTCPeerConnection：完美协商 / trickle ICE / ICE 重启 / SAS / 媒体轨
    mesh.ts           房间会话：编排信令与多个 Peer、屏幕共享媒体轨挂载
    channels.ts       数据通道参数与背压工具（文件传输复用）
    messages.ts       control 通道上的应用层消息（判别式联合：聊天/文件/屏幕/绘制/指针）
    filetransfer.ts   文件收发（分块 + 背压 + 取消）
    draw.ts           白板/批注共用：笔画渲染、坐标归一化、成员配色
    security.ts       SAS 短认证串：从双方 DTLS 指纹派生 emoji/数字供带外核对
    capabilities.ts   运行环境能力探测（安全上下文 / 屏幕共享 / 文件系统等）
  stores/
    room.ts           Pinia：把 Mesh 事件映射为响应式 UI 状态
  components/
    SideNav.vue       左侧功能导航
    ConnectView.vue   短码/链接/房间口令直连 + 设备卡片(SAS 校对)
    SendView.vue      发送文件    ReceiveView.vue  接收文件
    ChatView.vue      文本消息    TransferItem.vue 传输条目
    ScreenView.vue    屏幕共享：共享/观看/远程指针/批注
    BoardView.vue     互动白板（16:9 逻辑画板 + 导出 PNG）
    DrawLayer.vue     绘制叠加层：canvas 重绘 + 指针输入 + 远程光标/涟漪
    DrawToolbar.vue   画笔工具栏（屏幕批注与白板共用）
```

## 本地开发

前端由 `pphub` 单二进制在编译期嵌入（`web/dist`），运行时同端口提供网页与信令。

**方式一：一体化（贴近生产）**

```bash
npm install
npm run build                 # 产出 web/dist，会被 cargo 嵌入
cargo run -- -p 8848          # 在仓库根目录执行
```

打开 `http://localhost:8848`，两个标签页填**相同房间名**即可端到端聊天。

**方式二：前端热更新（开发）**

```bash
# 终端 1（仓库根目录）：信令服务器，默认 0.0.0.0:8848
cargo run

# 终端 2：Vite 开发服务器，http://localhost:5173
cd web && npm install && npm run dev
```

Vite 已把 `/ws` 代理到 `ws://localhost:8848`，因此前端始终用同源 `ws://<host>/ws`，
与一体化部署一致；也可用 `.env` 里的 `VITE_SIGNALING_URL` 覆盖。

> `localhost` 天然算「安全上下文」，开发时无需 https。经局域网 IP 明文访问时
> `crypto.subtle`（SAS + WS 中继加密）、`getDisplayMedia`、剪贴板 API 会被浏览器
> 禁用，进入网络页会显示一条黄色横幅说明受限项；`RTCPeerConnection` 与数据通道
> 本身不受影响，同网段直连、聊天、文件、白板都正常。

## 脚本

- `npm run dev` —— 开发服务器（/ws 代理到 8848）
- `npm run build` —— 类型检查（vue-tsc）+ 生产构建（产出 web/dist）
- `npm run typecheck` —— 仅类型检查
- `node scripts/smoke-signaling.mjs` —— 信令协议端到端冒烟测试。默认连 `ws://127.0.0.1:8090/ws`，
  可用 `PPHUB_WS=ws://127.0.0.1:8848/ws node scripts/smoke-signaling.mjs` 指向任意实例；
  被测服务器若以 `--stun-turn` 启动，需同时设 `PPHUB_STUN_TURN=1` 以断言下发了 ICE 服务器
- `node scripts/smoke-relay.mjs` —— WS 应用层中继的线格式冒烟测试（帧头改写、
  载荷透传、非法帧与超限帧丢弃）。同样用 `PPHUB_WS` 指向实例
- `node scripts/e2e-media.mjs` —— 屏幕共享/批注/白板三端 E2E（需先 `cargo build` +
  `npm run build`；用 playwright-core 驱动本机缓存的 Chromium，`getDisplayMedia` 以
  canvas 假流注入，WebRTC 协商与媒体轨/DataChannel 全走真实路径）
- `node scripts/e2e-network.mjs` —— 网络视图/名片/单播广播/多源下载/私有白板三端 E2E
- `node scripts/e2e-relay.mjs` —— 单端口降级路径 E2E：服务器按默认方式启动
  （不加 `--stun-turn`，只监听 HTTP 端口），浏览器打开 `pphub:force:relay`
  跳过 WebRTC，验证中继下的 SAS 一致性、聊天、白板、文件与分块下载

## 安全模型（务必理解）

- 信令服务器**只**转发 SDP/ICE 与签发 TURN 凭证，不经手任何业务数据。
- WebRTC 的 DTLS 已对数据/媒体端到端加密，但信令服务器理论上能替换 SDP 指纹发起中间人攻击。
  因此「端到端加密」成立的前提是：**两端用户带外核对 SAS**（成员卡片里的 emoji / 数字）一致。
