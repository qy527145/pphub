//! 内置 STUN/TURN 服务器（基于 webrtc-rs `turn` crate）。
//!
//! 设计依据：客户端必然能访问 pphub 的 web/信令端口，因此 pphub 所在主机
//! 天然是最合适的 STUN/TURN 服务器——无需依赖任何第三方公共服务。
//!
//! 需额外开放端口，故默认不启动（见 `--stun-turn`）；不启动时跨网对端改走
//! ws.rs 的应用层中继。启动后：
//! - UDP 端口同时应答 STUN Binding（打洞探测）与 TURN Allocate（中继）；
//! - **TCP 端口**提供 TURN over TCP（RFC 5766 §5.1）：客户端到服务器全程 TCP，
//!   可穿越禁 UDP 的网络，且能直接置于 nginx `stream` 之后。两端都走 TURN 时
//!   中继腿在服务器进程内部完成，对外只需这一个 TCP 端口；
//! - 凭证走 TURN REST API 规则（username=过期时间戳，credential=HMAC），
//!   共享密钥进程启动时随机生成，只存在于内存，无需任何配置；
//! - 前端用 `location.hostname` + 本模块端口拼出 `stun:`/`turn:` URL，
//!   保证「客户端能打开网页 ⇒ 就能用上这台 STUN/TURN」。

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use tokio::net::UdpSocket;
use tokio::time::Duration;
use turn::auth::{generate_auth_key, AuthHandler};
use turn::relay::relay_static::RelayAddressGeneratorStatic;
use turn::server::config::{ConnConfig, ServerConfig};
use turn::server::Server;
use webrtc_util::vnet::net::Net;

use crate::config::Config;
use crate::protocol::BuiltinIce;
use crate::tcp_turn::TcpTurn;
use crate::turn::{make_credentials, now_secs, password_for};

const REALM: &str = "pphub";

/// 运行中的内置中继：保存端口与密钥，供信令层签发凭证。
pub struct BuiltinRelay {
    /// 实际监听的 UDP 端口；0 表示未启用（纯 TCP 部署）。
    pub udp_port: u16,
    /// 实际监听的 TURN over TCP 端口；0 表示未启用。
    pub tcp_port: u16,
    /// 进程内随机密钥（永不下发，仅用于签发/校验凭证）。
    secret: String,
    /// 持有 Server 以维持其内部任务存活。
    _server: Server,
}

impl BuiltinRelay {
    /// 启动内置 STUN/TURN。失败（如端口被占用）时返回 None 并降级继续运行。
    pub async fn start(cfg: &Config) -> Option<Arc<BuiltinRelay>> {
        // 默认不加 --stun-turn：不监听任何额外端口，跨网对端走 WS 应用层中继。
        if cfg.udp_port == 0 && cfg.tcp_port == 0 {
            tracing::info!("单端口模式：未启用内置 STUN/TURN，打不通的对端将走 WS 应用层中继（加 --stun-turn 可开启打洞）");
            return None;
        }

        let relay_ip = match cfg
            .public_ip
            .as_deref()
            .and_then(|s| s.parse::<IpAddr>().ok())
            .or_else(detect_local_ip)
        {
            Some(ip) => ip,
            None => {
                tracing::warn!("无法确定本机 IP，内置 STUN/TURN 未启动（可设 PPHUB_PUBLIC_IP）");
                return None;
            }
        };

        // 每个监听 socket 需要独立的中继地址生成器。
        let make_gen = || -> Box<RelayAddressGeneratorStatic> {
            Box::new(RelayAddressGeneratorStatic {
                relay_address: relay_ip,
                address: "0.0.0.0".to_owned(),
                net: Arc::new(Net::new(None)),
            })
        };

        let mut conn_configs = Vec::new();
        let mut udp_port = 0;
        let mut tcp_port = 0;

        // UDP：STUN 打洞 + TURN/UDP。禁用时（PPHUB_UDP_PORT=0）跳过。
        if cfg.udp_port > 0 {
            match UdpSocket::bind(("0.0.0.0", cfg.udp_port)).await {
                Ok(c) => {
                    udp_port = c.local_addr().ok()?.port();
                    conn_configs.push(ConnConfig {
                        conn: Arc::new(c),
                        relay_addr_generator: make_gen(),
                    });
                }
                Err(e) => tracing::warn!(
                    "UDP {} 绑定失败（{e}），跳过 UDP 监听（可设 PPHUB_UDP_PORT 换端口或设 0 关闭）",
                    cfg.udp_port
                ),
            }
        }

        // TCP：TURN over TCP，可经 nginx stream 转发，不需要任何 UDP 端口对外。
        if cfg.tcp_port > 0 {
            match TcpTurn::bind(("0.0.0.0", cfg.tcp_port)).await {
                Ok(c) => {
                    tcp_port = c.port();
                    conn_configs.push(ConnConfig {
                        conn: Arc::new(c),
                        relay_addr_generator: make_gen(),
                    });
                }
                Err(e) => tracing::warn!(
                    "TCP {} 绑定失败（{e}），跳过 TURN/TCP 监听（可设 PPHUB_TCP_PORT 换端口）",
                    cfg.tcp_port
                ),
            }
        }

        if conn_configs.is_empty() {
            tracing::warn!("内置 STUN/TURN 无可用监听端口，未启动");
            return None;
        }

        let secret = random_secret();
        let auth = SecretAuth {
            secret: secret.clone(),
        };

        let server = Server::new(ServerConfig {
            conn_configs,
            realm: REALM.to_owned(),
            auth_handler: Arc::new(auth),
            channel_bind_timeout: Duration::from_secs(0),
            alloc_close_notify: None,
        })
        .await;

        match server {
            Ok(server) => {
                let udp = if udp_port > 0 {
                    format!("udp/{udp_port} ")
                } else {
                    String::new()
                };
                let tcp = if tcp_port > 0 {
                    format!("tcp/{tcp_port} ")
                } else {
                    String::new()
                };
                tracing::info!("内置 STUN/TURN 已启动: {udp}{tcp}中继地址 {relay_ip}");
                Some(Arc::new(BuiltinRelay {
                    udp_port,
                    tcp_port,
                    secret,
                    _server: server,
                }))
            }
            Err(e) => {
                tracing::warn!("内置 STUN/TURN 启动失败: {e}");
                None
            }
        }
    }

    /// 为一个客户端签发临时凭证（前端据此拼 stun:/turn: URL）。
    pub fn issue_creds(&self, ttl: u64) -> BuiltinIce {
        let (username, credential) = make_credentials(&self.secret, ttl);
        BuiltinIce {
            udp_port: self.udp_port,
            tcp_port: self.tcp_port,
            username,
            credential,
        }
    }
}

/// 校验 TURN REST 凭证：username 是未过期的时间戳，密码由密钥重新派生比对。
struct SecretAuth {
    secret: String,
}

impl AuthHandler for SecretAuth {
    fn auth_handle(
        &self,
        username: &str,
        realm: &str,
        _src_addr: SocketAddr,
    ) -> Result<Vec<u8>, turn::Error> {
        let expiry: u64 = username
            .parse()
            .map_err(|_| turn::Error::Other("bad turn username".into()))?;
        if expiry < now_secs() {
            return Err(turn::Error::Other("turn credential expired".into()));
        }
        let password = password_for(&self.secret, username);
        Ok(generate_auth_key(username, realm, &password))
    }
}

/// 生成 256 位随机密钥（十六进制）。
fn random_secret() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("os rng available");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 探测本机对外网卡 IP：UDP connect 不发包，仅让内核选路。
fn detect_local_ip() -> Option<IpAddr> {
    let sock = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    sock.connect(("8.8.8.8", 80)).ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_unspecified() || ip.is_loopback() {
        None
    } else {
        Some(ip)
    }
}
