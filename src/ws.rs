//! WebSocket 连接生命周期：握手、读循环、写任务、断开清理。

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::AppState;
use crate::protocol::{ClientMsg, PEER_ID_MAX, RELAY_HDR, ServerMsg};
use crate::room::{JoinError, Out};
use crate::turn::build_ice_servers;

/// 每个客户端的发送队列容量。
///
/// 该队列承载信令（极小）、WS 1:1 中继（文件分块）与大房间的服务器扇出媒体
/// （屏幕/语音）。32 帧在途：足够吸收抖动，又不至于让内存随房间人数膨胀。
/// 1:1 中继投递 await 会形成背压（见 `Rooms::sender_of`）；扇出媒体则 `try_send`
/// 丢帧不阻塞（见 `Rooms::fanout`），短队列反而利于实时性——丢掉的是陈旧帧。
const CLIENT_QUEUE: usize = 32;

/// 单个中继帧的载荷上限（防止恶意客户端用巨帧打爆内存）。
const MAX_RELAY_FRAME: usize = 256 * 1024;

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Out>(CLIENT_QUEUE);

    // 写任务：把出站数据写入 WebSocket（JSON 文本帧 / 中继二进制帧）。
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let frame = match out {
                Out::Msg(msg) => match serde_json::to_string(&msg) {
                    Ok(json) => Message::Text(json.into()),
                    Err(err) => {
                        tracing::error!(?err, "序列化 ServerMsg 失败");
                        continue;
                    }
                },
                Out::Bin(buf) => Message::Binary(buf.into()),
            };
            if ws_tx.send(frame).await.is_err() {
                break;
            }
        }
    });

    // 当前连接加入的 (room, peer_id)；加入前为 None。
    let mut me: Option<(String, String)> = None;
    // 本连接是否已用过 WS 中继。仅用于打一条日志：运维据此判断某个客户端
    // 是走 P2P 还是降级到了服务器中继（`RUST_LOG=pphub=info`）。
    let mut relayed = false;

    while let Some(Ok(msg)) = ws_rx.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            // 二进制帧 = WS 中继载荷（fallback 传输）。载荷已被端到端加密，
            // 服务器只按帧头改写路由信息后转发，不解析、不留存内容。
            Message::Binary(buf) => {
                if !relayed && let Some((room, peer_id)) = &me {
                    relayed = true;
                    tracing::info!(%room, %peer_id, "peer 降级为 WS 中继（WebRTC 未连通）");
                }
                relay_binary(&state, &me, &buf).await;
                continue;
            }
            // Ping/Pong 由 axum 自动处理。
            _ => continue,
        };

        let cmd = match serde_json::from_str::<ClientMsg>(&text) {
            Ok(cmd) => cmd,
            Err(err) => {
                let _ = tx
                    .send(ServerMsg::error("bad-message", &err.to_string()).into())
                    .await;
                continue;
            }
        };

        match cmd {
            ClientMsg::Join {
                room,
                peer_id,
                nick,
                listen,
            } => {
                if me.is_some() {
                    let _ = tx
                        .send(ServerMsg::error("already-joined", "已在房间中").into())
                        .await;
                    continue;
                }
                match state.rooms.join(&room, &peer_id, nick, listen, tx.clone()) {
                    Ok(peers) => {
                        let _ = tx
                            .send(
                                ServerMsg::Joined {
                                    peer_id: peer_id.clone(),
                                    peers,
                                    code_len: state.rooms.recommended_code_len(),
                                }
                                .into(),
                            )
                            .await;
                        tracing::info!(%room, %peer_id, "peer joined");
                        me = Some((room, peer_id));
                    }
                    Err(JoinError::Full) => {
                        let _ = tx
                            .send(
                                ServerMsg::error(
                                    "room-full",
                                    &format!("房间已满（上限 {} 人）", state.rooms.max_peers()),
                                )
                                .into(),
                            )
                            .await;
                    }
                    Err(JoinError::Duplicate) => {
                        let _ = tx
                            .send(ServerMsg::error("duplicate-peer", "该 ID 已在房间中").into())
                            .await;
                    }
                    Err(JoinError::CodeTaken) => {
                        let _ = tx
                            .send(
                                ServerMsg::error("code-taken", "该短码已被其他设备监听").into(),
                            )
                            .await;
                    }
                }
            }

            ClientMsg::Signal { to, data } => match &me {
                Some((room, from)) => state.rooms.relay(room, from, &to, data),
                None => {
                    let _ = tx
                        .send(ServerMsg::error("not-joined", "请先加入房间").into())
                        .await;
                }
            },

            ClientMsg::TurnCreds => {
                let (ice_servers, ttl) = build_ice_servers(&state.config);
                let builtin = state.relay.as_ref().map(|r| r.issue_creds(ttl));
                let _ = tx
                    .send(
                        ServerMsg::TurnCreds {
                            ice_servers,
                            ttl,
                            builtin,
                        }
                        .into(),
                    )
                    .await;
            }

            ClientMsg::Leave => break,
        }
    }

    // 断开清理：从房间移除并通知其余成员。
    if let Some((room, peer_id)) = me {
        state.rooms.leave(&room, &peer_id);
        tracing::info!(%room, %peer_id, "peer left");
    }
    writer.abort();
}

/// 转发一帧 WS 中继数据。外层首字节为版本，据此分流：
///
/// 版本 1 —— **1:1 中继**（P2P 打不通时的 fallback 传输）：
///   [0]        版本 1
///   [1]        peerId 字节长度 n（1..=32）
///   [2..2+n]   入站 = 目标 peerId；出站（改写后）= 来源 peerId
///   [2+n..]    端到端加密的载荷，服务器不解析
///   用 `send().await` 而非 `try_send`：接收方队列满时在此挂起，
///   反压传导到发送方的 WS 读循环（本函数在读循环内被 await），因为中继
///   承载文件分块等不可丢的数据。
///
/// 版本 2 —— **服务器扇出**（路线乙，大房间媒体）：
///   [0]        版本 2
///   [1..]      发送端已用媒体群密钥加密的载荷（内层含 nonce/kind/包体）
///   服务器在载荷前戳上来源 peerId，`try_send` 复制给房间其余成员（丢帧不阻塞，
///   见 `Rooms::fanout`）。服务器看不到明文，只做扇出。
async fn relay_binary(state: &AppState, me: &Option<(String, String)>, buf: &[u8]) {
    let Some((room, from)) = me else { return };
    if buf.is_empty() || from.len() > PEER_ID_MAX {
        return;
    }

    match buf[0] {
        // —— 版本 1：1:1 中继（背压 await）——
        1 => {
            if buf.len() < RELAY_HDR {
                return;
            }
            let id_len = buf[1] as usize;
            if id_len == 0
                || id_len > PEER_ID_MAX
                || buf.len() < RELAY_HDR + id_len
                || buf.len() > RELAY_HDR + id_len + MAX_RELAY_FRAME
            {
                return;
            }
            let Ok(to) = std::str::from_utf8(&buf[RELAY_HDR..RELAY_HDR + id_len]) else {
                return;
            };
            let Some(dst) = state.rooms.sender_of(room, to) else {
                return;
            };

            // 复用帧结构：把「目标」字段改写为「来源」，载荷跟随。
            let payload = &buf[RELAY_HDR + id_len..];
            let mut out = Vec::with_capacity(RELAY_HDR + from.len() + payload.len());
            out.push(1);
            out.push(from.len() as u8);
            out.extend_from_slice(from.as_bytes());
            out.extend_from_slice(payload);
            let _ = dst.send(crate::room::Out::Bin(out)).await;
        }
        // —— 版本 2：服务器扇出（try_send 丢帧）——
        2 => {
            let payload = &buf[1..];
            if payload.is_empty() || payload.len() > MAX_RELAY_FRAME {
                return;
            }
            state.rooms.fanout(room, from, payload);
        }
        _ => {}
    }
}
