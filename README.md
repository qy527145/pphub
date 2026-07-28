# pphub

免安装、纯浏览器的 P2P 直连协作系统。基于 WebRTC，**单二进制**：前端在编译期
嵌入 Rust 服务，运行后一个进程同时提供网页、信令服务器（交换 SDP/ICE）与
数据中继。数据优先端到端直传；仅在直连不可能的网络下走中继，且中继的始终是密文。

**默认只监听一个 HTTP 端口**——直接放到 nginx 后面就能用，不需要开放任何额外
端口。同网段的节点用 host 候选直接打通（不经服务器）；跨网络打不通的节点自动
降级到同一条 WebSocket 上的应用层中继。

加 `--stun-turn` 会额外监听 UDP+TCP 3478 启用内置 STUN/TURN，换来真正的 NAT
打洞与 ICE 层中继：跨网络场景下更可能直连，屏幕共享也能带上音频。

传输按以下顺序自动降级，无需其它配置：

| 级别 | 通路 | 需要的端口 | 加密 | 屏幕共享 |
|------|------|-----------|------|---------|
| 1 | P2P 直连（同网段 host 候选） | 无 | DTLS/SRTP | ✅ 含音频 |
| 2 | P2P 直连（内置 STUN 打洞） | UDP 3478（`--stun-turn`） | DTLS/SRTP | ✅ 含音频 |
| 3 | 内置 TURN over UDP | UDP 3478（`--stun-turn`） | DTLS/SRTP | ✅ 含音频 |
| 4 | 内置 TURN over TCP | TCP 3478（`--stun-turn`） | DTLS/SRTP | ✅ 含音频 |
| 5 | WS 应用层中继 | 无（复用 HTTP 端口） | ECDH + AES-GCM | ✅ 仅视频 |

最后一级是默认配置下的兜底。WebRTC 媒体轨过不了应用层中继（SRTP 在浏览器
内部收发，JS 拿不到编码帧），所以这条路径改用 **WebCodecs 自行编码**：画面
编码成字节后混在同一条加密中继通道里走，对端解码回 `MediaStream`，渲染与
批注链路完全不变。代价是**没有音频**、画质与延迟不如原生媒体轨，且两端都需要
浏览器支持 WebCodecs（https/localhost 下的现代 Chromium 系；Safari 17+）。
不支持时 pphub 会直说原因，而不是给一个永远黑屏的画面。

## 快速开始

```bash
# 直接跑（默认监听 0.0.0.0:8848，只占这一个端口）
cargo run

# 指定主机/端口
cargo run -- --port 8848
cargo run -- -H 127.0.0.1 -p 8848

# 额外启用内置 STUN/TURN（多占 UDP+TCP 3478，换取跨网打洞与带音频的屏幕共享）
cargo run -- --stun-turn
```

启动后浏览器打开 `http://localhost:8848`。左侧为功能导航（网络 / 发送文件 /
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
https 或 localhost；移动端浏览器无此 API，只能观看）。直连时画面走 WebRTC 媒体
轨端到端直传（含音频）；降级到 WS 中继的对端则改走 WebCodecs 自编码的视频流
（无音频）——两条路径对上层一致，都支持面向全网或仅共享给指定节点、多人同时
共享、观看端切换画面与声音开关。

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
| `-p, --port` | 监听端口 | `8848` | `PPHUB_PORT` |
| `--stun-turn` | 额外启用内置 STUN/TURN（UDP+TCP 3478） | 关闭 | `PPHUB_STUN_TURN` |

## 默认：单端口（只暴露 nginx 的 80/443）

```bash
cargo run                       # 只监听 8848 这一个端口
```

不监听 UDP/TCP 3478，nginx 只需代理 HTTP + WebSocket：

```nginx
location /pphub/ {
    proxy_pass http://127.0.0.1:8848/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;   # WebSocket 升级必需
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_read_timeout 3600s;                    # 长连接，别让 nginx 掐断
}
```

同一局域网内的节点仍会用 host 候选直连（不经服务器）；跨网络节点在 WebRTC
失败后自动改走 **WS 应用层中继**：数据经 `/ws` 的二进制帧由服务器转发，
但先在浏览器里用 **ECDH(P-256) 协商的 AES-GCM** 加密，服务器只看得到密文和
路由用的 peerId。两端可核对 SAS（由双方公钥派生）确认没有中间人。

降级发生时网络视图会把该节点标为「**中继**」而非「已连接」，不伪装成直连。

两个必须知道的限制：

- **中继路径上的屏幕共享没有音频**。WebRTC 媒体轨由浏览器内部 SRTP 栈收发，
  JS 拿不到编码帧，无法经应用层转发；这条路径改由 WebCodecs 自行编码视频后
  混进中继通道，因此只有画面，且画质/延迟不如原生媒体轨。两端浏览器都需要
  WebCodecs（现代 Chromium 系、Safari 17+，且必须是安全上下文）；不支持时
  界面会说明原因而不是黑屏。要音频与更好的画质就开 `--stun-turn`。
- **中继需要安全上下文**。浏览器只在 https 或 localhost 下提供 `crypto.subtle`，
  以明文 http + 局域网 IP 访问时中继无法加密，此时 pphub 宁可拒绝降级也不
  明文转发，界面会提示改用 https 或放行 3478。详见下节。

## 用 http 访问（非 localhost）会失去什么

浏览器把「https 或 localhost」之外的页面判定为**非安全上下文**并禁用一批 API。
以下为在 Chromium 上对 `http://<局域网 IP>:<端口>` 的实测结果：

| 能力 | http + 局域网 IP | 影响 |
|---|---|---|
| `RTCPeerConnection` / DataChannel | ✅ 可用 | 同网段直连、聊天、文件、白板全部正常 |
| `crypto.subtle` | ❌ | **SAS 安全核验失效**；**WS 中继被拒绝**，打不通的对端彻底连不上 |
| `getDisplayMedia` | ❌ | 无法发起屏幕共享（仍可观看他人共享） |
| WebCodecs（`VideoEncoder`/`VideoDecoder`） | ❌ | 中继路径的屏幕共享不可用（直连路径不受影响） |
| `navigator.clipboard` | ❌ | 自动退回 `execCommand('copy')`，复制功能仍可用 |
| `crypto.randomUUID` | ❌ | 无影响，已用 `getRandomValues` 兜底 |
| `showSaveFilePicker` / OPFS | ❌ | 无影响，收文件本就是内存 Blob，未用这两个 API |

**最需要注意的是 `crypto.subtle`**：它同时砍掉了中间人核验和唯一的中继兜底。
也就是说明文 http + 默认单端口的组合下，**只有同网段的设备能互连**。

进入网络页时会显示一条黄色横幅列出以上受限项，不必等到连接失败才发现。要恢复
全部能力，给 nginx 配 https（局域网可用 mkcert 自签并在各设备装根证书，或用真实
域名解析到内网 IP 走 Let's Encrypt DNS-01）；或者退一步开 `--stun-turn`，让 ICE
层打洞接住跨网络那部分，这样即使没有 https 也不必依赖 WS 中继。

## 内置 STUN/TURN（`--stun-turn`，NAT 穿透）

```bash
cargo run -- --stun-turn        # 额外监听 UDP 3478 + TCP 3478
```

客户端既然能打开 pphub 的网页，就必然能连到 pphub 所在主机——因此 pphub
**自带 STUN/TURN 服务器**，随进程启动，不依赖任何第三方公共服务。开启后：

1. **P2P 直连（优先）**：内置 STUN 应答 Binding 请求，帮两端发现各自的
   公网映射地址并打洞；打洞成功后所有数据端到端直传，服务器只承担信令。
2. **TURN/UDP 中继（自动兜底）**：对称型 NAT、严格防火墙等打洞必败的环境下，
   浏览器 ICE 自动改走内置 TURN 中继。中继发生在 ICE 层，对上层完全透明，
   数据通道与屏幕共享媒体流全都可用；DTLS 端到端加密不变，服务器只见密文。
3. **TURN/TCP 中继（最终兜底）**：连 UDP 都被禁的网络下，客户端到服务器
   全程走 TCP。两端都经 TURN 时中继腿在服务器进程内部完成，**对外只需
   HTTP 端口 + 这一个 TCP 端口**，不需要任何 UDP 端口可达。

TURN 凭证走 REST API 规则（username=过期时间戳，credential=HMAC-SHA1），
共享密钥进程启动时随机生成、只存在内存，无需也无法配置泄露。前端用
`location.hostname` + 下发的端口拼出 `stun:`/`turn:`/`turn:…?transport=tcp` URL，
浏览器 ICE 按 直连 > UDP 中继 > TCP 中继 的优先级自动择优。

**部署要点**：

- 最佳体验放行 UDP 3478；受限环境只放行 **TCP 3478** 也能全功能互通
  （消息/文件/白板/屏幕共享，走 TURN/TCP 中继），用
  `--stun-turn` + `PPHUB_UDP_PORT=0` 即可；
- nginx 只代理 HTTP/WS。TURN/TCP 是原始 TCP 流，不能挂在 HTTP `location`
  下（这是浏览器 ICE 栈的限制：JS 无法把 WebSocket 塞进 RTCPeerConnection
  的传输层），但可用 nginx `stream` 模块四层转发，使对外统一由 nginx 承接：

  ```nginx
  # /etc/nginx/nginx.conf 顶层（与 http {} 平级）
  stream {
      server {
          listen 3478;            # 对外 TURN/TCP
          proxy_pass 127.0.0.1:3478;
      }
  }
  ```

- 经 nginx stream 转发（或其它代理/NAT）时，TURN 看到的客户端源地址是代理
  地址，属正常情况，不影响中继；
- 服务器多网卡/容器/VPN 环境下自动探测的 IP 不对时，用 `PPHUB_PUBLIC_IP`
  显式指定中继宣告地址（应为服务器本机已配置的 IP，如局域网部署用其内网
  IP）；
- 端口被占用时对应监听自动跳过，其余功能不受影响（退回 WS 应用层中继）。

环境变量一览：`PPHUB_STUN_TURN=1`（等价于 `--stun-turn`）、`PPHUB_UDP_PORT`
（STUN+TURN/UDP 端口，开启时默认 3478，设 0 单独关闭）、`PPHUB_TCP_PORT`
（TURN/TCP 端口，同上）、`PPHUB_PUBLIC_IP`（中继宣告 IP，默认自动探测）、
`PPHUB_TURN_TTL`（凭证有效期，默认 3600 秒）、`PPHUB_MAX_PEERS`（房间上限，
默认 6）。仍可通过 `PPHUB_STUN_URLS` / `PPHUB_TURN_URLS` / `PPHUB_TURN_SECRET`
追加外部 STUN/coturn 作为补充（默认为空，通常不需要）。

## 连不上时看哪里的日志

问题几乎总能在两侧之一定位，**先看客户端**：那里才有 ICE 的真实结果。

**客户端（浏览器）**

1. **ICE 详情**——控制台执行后刷新页面：
   ```js
   localStorage.setItem('pphub:debug:ice', 'true')
   ```
   随后控制台会打印每个候选（host / srflx / relay）、收集与连接状态变化，
   以及最终选中的候选对，并标出路径类型：直连 / STUN 穿透 / TURN 中继。
   - 只有 `host` 候选，且对端不同网段 ⇒ 默认单端口模式下这是预期结果，
     应当看到随后降级为 WS 中继；想直连就加 `--stun-turn`；
   - 开了 `--stun-turn` 仍只有 `host` ⇒ 没连上内置 STUN，检查 UDP 3478 可达性；
   - 有 `srflx` 但状态停在 `checking`/`failed` ⇒ 打洞失败，看是否降级到了
     `relay`（内置 TURN）；
   - 控制台出现 `[peer] <id> 降级到 WS 中继：…` ⇒ 已走最后一级，冒号后是原因。

2. **浏览器原生面板**（信息最全）：Chrome/Edge 打开 `chrome://webrtc-internals`，
   在连接建立**之前**打开该页，然后再进房；里面有完整的 ICE 候选对表格、
   选中路径、收发字节数。

3. **强制走中继**（验证降级链路本身是否可用）：
   ```js
   localStorage.setItem('pphub:force:relay', 'true')   // 刷新后生效，删除即恢复
   ```

**服务端**

用 `RUST_LOG` 调整级别（默认 `info`）：

```bash
RUST_LOG=pphub=debug cargo run
RUST_LOG=pphub=debug,tower_http=debug ./pphub      # 连 HTTP 请求也打
```

关键行：

- `启动 pphub … udp_port=… tcp_port=…`：确认监听模式，两者都是 0 即单端口模式；
- `单端口模式：未启用内置 STUN/TURN…`：默认启动会打这一行，属正常；
- `内置 STUN/TURN 已启动: udp/3478 tcp/3478 中继地址 192.168.x.x`（加了
  `--stun-turn` 才有）：末尾这个**中继地址必须是客户端能访问到的 IP**。
  多网卡 / 容器 / **开着 VPN** 的机器容易探测成虚拟网卡地址（如 `198.18.x.x`），
  此时局域网对端根本连不上，需显式指定 `PPHUB_PUBLIC_IP=192.168.x.x`；
- `内置 STUN/TURN 无可用监听端口，未启动`：加了 `--stun-turn` 但端口被占用；
- `peer joined` / `peer left`：信令层进出房间；
- `peer 降级为 WS 中继（WebRTC 未连通）`：该客户端已走最后一级中继。

nginx 反代时还需看 nginx 的 `error.log`——WebSocket 升级头没配对时，
`/ws` 会以 400/426 失败，页面表现为一直「连接中」。

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
  relay.rs          内置 STUN/TURN 服务器（UDP 打洞 + UDP/TCP 中继兜底）
  tcp_turn.rs       TURN over TCP 适配器（RFC 5766 §5.1 流式分帧）
  turn.rs           TURN 临时凭证（HMAC-SHA1，REST API 规则）
  ws.rs             WebSocket 连接生命周期 + WS 应用层中继转发
web/                前端源码（Vue 3 + TS + Vite），详见 web/README.md
  dist/             前端构建产物，随仓库提交并被嵌入二进制
```

## 开发

前端改动后需重新构建并嵌入：

```bash
npm --prefix web install
npm --prefix web run build     # 产出 web/dist（会被 cargo 嵌入）
cargo run -- -p 8848
```

或前后端分离热更新（Vite 通过 /ws 代理到本地信令服务器）：

```bash
cargo run -- -p 8848           # 终端 1：信令
npm --prefix web run dev       # 终端 2：http://localhost:5173
```

> `localhost` 天然算「安全上下文」，开发时无需 https。经局域网 IP 明文访问时
> 部分浏览器 API 会被禁用（SAS、屏幕共享、WS 中继等），详见下节；WebRTC 数据
> 通道本身不受影响。

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
