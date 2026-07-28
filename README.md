# pphub

免安装、纯浏览器的 P2P 直连协作系统。基于 WebRTC，**单二进制**：前端在编译期
嵌入 Rust 服务，运行后同一端口既提供网页，又充当信令服务器（仅交换 SDP/ICE、
签发 TURN 凭证，**不中转任何业务数据**）。

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

STUN/TURN 等其余配置走环境变量：`PPHUB_STUN_URLS`、`PPHUB_TURN_URLS`、
`PPHUB_TURN_SECRET`、`PPHUB_TURN_TTL`、`PPHUB_MAX_PEERS`。TURN 共享密钥只留在
服务端，绝不下发前端。

## 项目结构

```
Cargo.toml          单 crate（package = "pphub"）
build.rs            确保 web/dist 存在，供 rust-embed 编译期嵌入
src/
  main.rs           CLI(clap) + 路由：/ 前端、/ws 信令、/healthz
  assets.rs         嵌入式前端静态资源 + SPA 回退
  config.rs         环境变量配置（STUN/TURN/上限）
  protocol.rs       信令线格式（serde）
  room.rs           房间注册表 + 信令中继
  turn.rs           TURN 临时凭证（HMAC-SHA1）
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
