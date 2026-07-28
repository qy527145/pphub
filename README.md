# pphub

免安装、纯浏览器的 P2P 直连协作系统。基于 WebRTC，**单二进制**：前端在编译期
嵌入 Rust 服务，运行后一个进程同时提供网页、信令服务器（交换 SDP/ICE）与
**内置 STUN/TURN**（NAT 打洞 + 打洞失败时的中继兜底）。数据优先端到端直传；
仅在直连不可能的网络下经内置 TURN 中继，且中继的也只是 DTLS 密文。

## 快速开始

```bash
# 直接跑（默认监听 0.0.0.0:8080）
cargo run

# 指定主机/端口
cargo run -- --port 8089
cargo run -- -H 127.0.0.1 -p 8089
```

启动后浏览器打开 `http://localhost:8089`。左侧为功能导航（网络 / 发送文件 /
接收文件 / 消息 / 屏幕共享 / 互动白板），底部可切换日间/夜间两套主题
（默认跟随系统）。三种方式任选其一即可直连——

1. **短码**：把首页的 6 位临时短码告诉对方，对方输入即连（「允许短码连我」默认开启）；
2. **链接**：复制分享链接，对方浏览器打开自动连接；
3. **房间口令**：多台设备（≤6）输入同一口令互连成全网状 Mesh。

**网络视图**：所有节点连成一张网——本机居中、对端环形分布，节点间按真实
P2P 连通性连边（各端邻接表经 DataChannel gossip 同步）。点对端节点头像即可
私聊、发文件、共享屏幕给 TA、开私有白板、核验 SAS 指纹；点自己的节点编辑
名片（昵称 + emoji/图片头像，实时同步到全网）；底部动作条面向全网群聊、
群发文件、共享屏幕、公共白板。

连接后可端到端互传文件与文本消息（群聊 + 一对一私聊）。「安全核验」弹层显示
SAS（emoji/数字），两端带外核对一致才代表未被中间人篡改。

**发文件**：支持单播（发给指定节点）与广播（发给全网），两种发送模式——

- **强制发送**：选择后立即经加密数据通道推送到对方设备（分块 + 背压 + 进度/取消）；
- **懒发送**：只把文件登记为共享（零上传），对方点下载才开始供块；下载过的
  节点自动成为新的源，后续下载者按「稀有块优先」从多个源并行拉块（BitTorrent
  式多源分发），避免共享方单点负载过高。

**屏幕共享**：桌面端浏览器可一键共享屏幕/窗口/标签页（`getDisplayMedia`，需
https 或 localhost；移动端浏览器无此 API，只能观看）。画面走 WebRTC 媒体轨端
到端直传，支持面向全网或仅共享给指定节点、多人同时共享、观看端切换画面与声
音开关。

**屏幕控制（远程指挥）**：观看端可在对方画面上使用远程指针、点击提示与透明
画笔批注，实时显示在共享端预览与所有观看端上。受浏览器安全模型限制（合成键
鼠事件 `isTrusted=false`，无法注入对端系统），纯浏览器做不到完整远程键鼠控
制——那需要在被控端安装原生程序，本项目按「免安装」原则不做。

**互动白板**：16:9 共享画板，画笔/橡皮/撤销/清空/导出 PNG；笔画经 DataChannel
实时同步（含成员光标），新加入的设备自动获得全量画面。支持公共白板（全网）
与两节点私有白板（仅双方可见）。

## 命令行参数

| 参数 | 说明 | 默认 | 环境变量 |
|------|------|------|---------|
| `-H, --host` | 监听主机 | `0.0.0.0` | `PPHUB_HOST` |
| `-p, --port` | 监听端口 | `8080` | `PPHUB_PORT` |

## 内置 STUN/TURN（NAT 穿透，零配置）

客户端既然能打开 pphub 的网页，就必然能连到 pphub 所在主机——因此 pphub
**自带 STUN/TURN 服务器**，随进程在同一台机器的 UDP 端口（默认 3478）启动，
不依赖任何第三方公共服务：

1. **P2P 直连（优先）**：内置 STUN 应答 Binding 请求，帮两端发现各自的
   公网映射地址并打洞；打洞成功后所有数据端到端直传，服务器只承担信令。
2. **TURN 中继（自动兜底）**：对称型 NAT、严格防火墙等打洞必败的环境下，
   浏览器 ICE 自动改走内置 TURN 中继。中继发生在 ICE 层，对上层完全透明，
   数据通道与屏幕共享媒体流全都可用；DTLS 端到端加密不变，服务器只见密文。

TURN 凭证走 REST API 规则（username=过期时间戳，credential=HMAC-SHA1），
共享密钥进程启动时随机生成、只存在内存，无需也无法配置泄露。前端用
`location.hostname` + 下发的 UDP 端口拼出 `stun:`/`turn:` URL。

**部署要点**：

- 客户端需能访问服务器的 **UDP 端口 3478**（防火墙放行；nginx 只代理 HTTP/WS，
  UDP 流量是客户端直连主机的，不经过 nginx）；
- 服务器多网卡/容器环境下自动探测的 IP 不对时，用 `PPHUB_PUBLIC_IP` 显式指定
  中继宣告地址；服务器在 NAT 后对公网服务时同样需要设置公网 IP 并做端口映射；
- `PPHUB_UDP_PORT` 更换 UDP 端口；端口被占用时内置中继跳过启动、其余功能不受影响。

环境变量一览：`PPHUB_UDP_PORT`（内置 STUN/TURN 端口，默认 3478）、
`PPHUB_PUBLIC_IP`（中继宣告 IP，默认自动探测）、`PPHUB_TURN_TTL`（凭证有效期，
默认 3600 秒）、`PPHUB_MAX_PEERS`（房间上限，默认 6）。仍可通过
`PPHUB_STUN_URLS` / `PPHUB_TURN_URLS` / `PPHUB_TURN_SECRET` 追加外部
STUN/coturn 作为补充（默认为空，通常不需要）。

**连接诊断**：浏览器控制台执行 `localStorage.setItem('pphub:debug:ice', 'true')`
后刷新，可看到 ICE 候选收集与最终选中的连接路径（host 直连 / srflx 打洞 /
relay 中继）。

## 项目结构

```
Cargo.toml          单 crate（package = "pphub"）
build.rs            确保 web/dist 存在，供 rust-embed 编译期嵌入
src/
  main.rs           CLI(clap) + 路由：/ 前端、/ws 信令、/healthz
  assets.rs         嵌入式前端静态资源 + SPA 回退
  config.rs         环境变量配置（UDP 端口/公网 IP/上限等）
  protocol.rs       信令线格式（serde）
  room.rs           房间注册表 + 信令中继
  relay.rs          内置 STUN/TURN 服务器（打洞 + 中继兜底）
  turn.rs           TURN 临时凭证（HMAC-SHA1，REST API 规则）
  ws.rs             WebSocket 连接生命周期
web/                前端源码（Vue 3 + TS + Vite），详见 web/README.md
  dist/             前端构建产物，随仓库提交并被嵌入二进制
```

## 开发

前端改动后需重新构建并嵌入：

```bash
npm --prefix web install
npm --prefix web run build     # 产出 web/dist（会被 cargo 嵌入）
cargo run -- -p 8089
```

或前后端分离热更新（Vite 通过 /ws 代理到本地信令服务器）：

```bash
cargo run -- -p 8080           # 终端 1：信令
npm --prefix web run dev       # 终端 2：http://localhost:5173
```

> WebRTC 与 SAS 指纹校验依赖「安全上下文」：`localhost` 天然满足；经局域网 IP
> 访问需 https，否则 `crypto.subtle` 不可用、SAS 降级。

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
