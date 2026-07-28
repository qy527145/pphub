//! 信令消息协议（JSON over WebSocket）。
//!
//! 服务器只负责：房间成员管理、SDP/ICE 候选中继、TURN 临时凭证签发。
//! `signal` 消息里的 `data` 对服务器是不透明的（SDP 或 ICE candidate），
//! 服务器原样转发，绝不解析业务含义。

use serde::{Deserialize, Serialize};

/// 房间成员的公开信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub peer_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nick: Option<String>,
}

/// 一个 ICE 服务器条目（STUN 或 TURN），下发给前端用于 `RTCPeerConnection`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// 客户端 → 服务器。
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ClientMsg {
    /// 加入房间；由后到者随后发起 offer，避免双向 glare。
    Join {
        room: String,
        peer_id: String,
        nick: Option<String>,
    },
    /// 主动离开房间。
    Leave,
    /// 向房间内某个对端转发信令（SDP / ICE candidate）。
    Signal {
        to: String,
        data: serde_json::Value,
    },
    /// 请求 TURN/STUN 临时凭证。
    TurnCreds,
}

/// 服务器 → 客户端。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ServerMsg {
    /// 加入成功，附带房间内已有成员列表。
    Joined {
        peer_id: String,
        peers: Vec<PeerInfo>,
    },
    /// 有新成员加入。
    PeerJoin { peer: PeerInfo },
    /// 有成员离开。
    PeerLeft { peer_id: String },
    /// 收到对端转发来的信令。
    Signal {
        from: String,
        data: serde_json::Value,
    },
    /// TURN/STUN 凭证响应；`ttl` 为凭证有效期（秒）。
    TurnCreds {
        ice_servers: Vec<IceServer>,
        ttl: u64,
    },
    /// 错误。
    Error { code: String, msg: String },
}

impl ServerMsg {
    pub fn error(code: &str, msg: &str) -> Self {
        ServerMsg::Error {
            code: code.to_string(),
            msg: msg.to_string(),
        }
    }
}
