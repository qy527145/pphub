//! 房间注册表与信令中继。
//!
//! 采用「共享状态 + 非阻塞发送」：所有操作在 `std::Mutex` 临界区内
//! 同步完成（克隆 sender、`try_send`），**不在持锁期间 await**，
//! 因此没有跨 await 持锁的死锁风险，也满足信令级别的吞吐。
//! 每个客户端连接持有一个有界 mpsc，写任务负责把消息推给 WebSocket。

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::mpsc;

use crate::protocol::{PeerInfo, ServerMsg};

/// 单个房间成员的投递槽。
struct PeerSlot {
    nick: Option<String>,
    tx: mpsc::Sender<ServerMsg>,
}

/// 一个房间。
#[derive(Default)]
struct Room {
    peers: HashMap<String, PeerSlot>,
}

/// 加入失败原因。
#[derive(Debug)]
pub enum JoinError {
    /// 房间已达成员上限。
    Full,
    /// 该 peerId 已在房间内。
    Duplicate,
}

/// 所有房间的注册表。
#[derive(Default)]
pub struct Rooms {
    inner: Mutex<HashMap<String, Room>>,
    max_peers: usize,
}

impl Rooms {
    pub fn new(max_peers: usize) -> Self {
        Rooms {
            inner: Mutex::new(HashMap::new()),
            max_peers,
        }
    }

    /// 加入房间。成功时返回房间内**已有**成员列表（不含自己），
    /// 并向已有成员广播 `peer-join`。
    pub fn join(
        &self,
        room: &str,
        peer_id: &str,
        nick: Option<String>,
        tx: mpsc::Sender<ServerMsg>,
    ) -> Result<Vec<PeerInfo>, JoinError> {
        let mut rooms = self.inner.lock().unwrap();
        let room = rooms.entry(room.to_string()).or_default();

        if room.peers.contains_key(peer_id) {
            return Err(JoinError::Duplicate);
        }
        if room.peers.len() >= self.max_peers {
            return Err(JoinError::Full);
        }

        let existing: Vec<PeerInfo> = room
            .peers
            .iter()
            .map(|(id, slot)| PeerInfo {
                peer_id: id.clone(),
                nick: slot.nick.clone(),
            })
            .collect();

        // 通知已有成员：新人来了（此时新人尚未插入，天然被排除）。
        let announce = ServerMsg::PeerJoin {
            peer: PeerInfo {
                peer_id: peer_id.to_string(),
                nick: nick.clone(),
            },
        };
        for slot in room.peers.values() {
            let _ = slot.tx.try_send(announce.clone());
        }

        room.peers.insert(peer_id.to_string(), PeerSlot { nick, tx });
        Ok(existing)
    }

    /// 把一条信令转发给房间内指定对端。
    pub fn relay(&self, room: &str, from: &str, to: &str, data: serde_json::Value) {
        let rooms = self.inner.lock().unwrap();
        if let Some(room) = rooms.get(room)
            && let Some(slot) = room.peers.get(to)
        {
            let _ = slot.tx.try_send(ServerMsg::Signal {
                from: from.to_string(),
                data,
            });
        }
    }

    /// 离开房间；向其余成员广播 `peer-left`，房间空则销毁。
    pub fn leave(&self, room: &str, peer_id: &str) {
        let mut rooms = self.inner.lock().unwrap();
        let Some(r) = rooms.get_mut(room) else {
            return;
        };
        if r.peers.remove(peer_id).is_none() {
            return;
        }
        let msg = ServerMsg::PeerLeft {
            peer_id: peer_id.to_string(),
        };
        for slot in r.peers.values() {
            let _ = slot.tx.try_send(msg.clone());
        }
        if r.peers.is_empty() {
            rooms.remove(room);
        }
    }
}
