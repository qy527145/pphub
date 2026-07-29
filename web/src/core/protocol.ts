// 与 Rust 信令服务器 (src/protocol.rs) 一一对应的线格式。
//
// 服务端使用 #[serde(tag = "t", rename_all = "kebab-case",
// rename_all_fields = "camelCase")]，因此：
//   - 变体标签在字段 "t"，kebab-case（如 "peer-join"）
//   - 各变体内部字段为 camelCase（如 peerId）

/** 房间成员信息。 */
export interface PeerInfo {
  peerId: string
  nick?: string | null
}

/** ICE 服务器条目（STUN 无凭证；TURN 带临时凭证）。 */
export interface IceServer {
  urls: string[]
  username?: string | null
  credential?: string | null
}

/**
 * 内置 STUN/TURN 的接入信息：服务端只知道端口与凭证，
 * 主机名由前端取 location.hostname 拼接（客户端能开网页 ⇒ 该主机可达）。
 */
export interface BuiltinIce {
  /** 内置 STUN/TURN 的 UDP 端口；0 表示未启用。 */
  udpPort: number
  /** 内置 TURN over TCP 端口；0 表示未启用。 */
  tcpPort: number
  username: string
  credential: string
}

/** 客户端 → 服务端。 */
export type ClientMsg =
  | { t: 'join'; room: string; peerId: string; nick?: string | null }
  | { t: 'leave' }
  | { t: 'signal'; to: string; data: SignalData }
  | { t: 'turn-creds' }

/** 服务端 → 客户端。 */
export type ServerMsg =
  | { t: 'joined'; peerId: string; peers: PeerInfo[] }
  | { t: 'peer-join'; peer: PeerInfo }
  | { t: 'peer-left'; peerId: string }
  | { t: 'signal'; from: string; data: SignalData }
  | { t: 'turn-creds'; iceServers: IceServer[]; ttl: number; builtin?: BuiltinIce | null }
  | { t: 'error'; code: string; msg: string }

/**
 * 端到端信令负载：服务端仅透传，不解析。
 * 前两种取自 MDN「完美协商」示例；relayKey 是降级到 WS 中继时交换的
 * X25519 公钥（base64）——收到它同时意味着「对端已降级」，本端应一并切到中继。
 */
export type SignalData =
  | { description: RTCSessionDescriptionInit; candidate?: undefined; relayKey?: undefined }
  | { candidate: RTCIceCandidateInit | null; description?: undefined; relayKey?: undefined }
  | { relayKey: string; description?: undefined; candidate?: undefined }
