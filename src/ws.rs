//! WebSocket 连接生命周期：握手、读循环、写任务、断开清理。

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::AppState;
use crate::protocol::{ClientMsg, ServerMsg};
use crate::room::JoinError;
use crate::turn::build_ice_servers;

/// 每个客户端的发送队列容量；信令量很小，64 足够。
const CLIENT_QUEUE: usize = 64;

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tx, mut rx) = mpsc::channel::<ServerMsg>(CLIENT_QUEUE);

    // 写任务：把服务器消息序列化后写入 WebSocket。
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Err(err) => tracing::error!(?err, "序列化 ServerMsg 失败"),
            }
        }
    });

    // 当前连接加入的 (room, peer_id)；加入前为 None。
    let mut me: Option<(String, String)> = None;

    while let Some(Ok(msg)) = ws_rx.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            // Ping/Pong 由 axum 自动处理；忽略二进制帧（信令走文本）。
            _ => continue,
        };

        let cmd = match serde_json::from_str::<ClientMsg>(&text) {
            Ok(cmd) => cmd,
            Err(err) => {
                let _ = tx
                    .send(ServerMsg::error("bad-message", &err.to_string()))
                    .await;
                continue;
            }
        };

        match cmd {
            ClientMsg::Join {
                room,
                peer_id,
                nick,
            } => {
                if me.is_some() {
                    let _ = tx
                        .send(ServerMsg::error("already-joined", "已在房间中"))
                        .await;
                    continue;
                }
                match state.rooms.join(&room, &peer_id, nick, tx.clone()) {
                    Ok(peers) => {
                        let _ = tx
                            .send(ServerMsg::Joined {
                                peer_id: peer_id.clone(),
                                peers,
                            })
                            .await;
                        tracing::info!(%room, %peer_id, "peer joined");
                        me = Some((room, peer_id));
                    }
                    Err(JoinError::Full) => {
                        let _ = tx
                            .send(ServerMsg::error("room-full", "房间已满（上限 6 人）"))
                            .await;
                    }
                    Err(JoinError::Duplicate) => {
                        let _ = tx
                            .send(ServerMsg::error("duplicate-peer", "该 ID 已在房间中"))
                            .await;
                    }
                }
            }

            ClientMsg::Signal { to, data } => match &me {
                Some((room, from)) => state.rooms.relay(room, from, &to, data),
                None => {
                    let _ = tx
                        .send(ServerMsg::error("not-joined", "请先加入房间"))
                        .await;
                }
            },

            ClientMsg::TurnCreds => {
                let (ice_servers, ttl) = build_ice_servers(&state.config);
                let builtin = state.relay.as_ref().map(|r| r.issue_creds(ttl));
                let _ = tx
                    .send(ServerMsg::TurnCreds {
                        ice_servers,
                        ttl,
                        builtin,
                    })
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
