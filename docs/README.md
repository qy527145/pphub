# pphub 文档中心

pphub 是一个纯浏览器、免安装的 P2P 协作工具：基于 WebRTC 数据/媒体通道，配合 Rust（axum + tokio）信令服务器，实现文件快传、聊天、屏幕共享、白板与轻量小游戏。核心定位是**零服务器带宽 + 真端到端加密**：数据恒全网状 P2P，媒体（屏幕/语音）按房间人数自适应——小房间纯 P2P，大房间由服务器**扇出端到端加密密文**（非 SFU 转码），可发给几十人。

## 文档导航

| 文档 | 内容 |
|------|------|
| [REQ_PRD.md](./REQ_PRD.md) | 原始产品需求（PRD），记录最初的功能设想 |
| [FEATURE_INVENTORY.md](./FEATURE_INVENTORY.md) | 功能可行性评估与已拍板的关键决策（媒体拓扑的取舍、为什么不做转码 SFU、不做原生伴侣程序） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | **权威技术架构文档**：系统设计、模块划分、消息协议、落地记录（§九） |
| [GAME_SYSTEM.md](./GAME_SYSTEM.md) | 游戏系统设计与已实现游戏一览 |

> 阅读顺序建议：`REQ_PRD`（想做什么）→ `FEATURE_INVENTORY`（哪些能做、拍了什么板）→ `ARCHITECTURE`（怎么实现的）。

项目整体说明与快速开始见仓库根目录的 [README](../README.md)。
