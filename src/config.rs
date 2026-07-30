//! 运行时配置，全部来自环境变量，带合理默认值。

/// 开启内置 STUN/TURN 时的默认监听端口（UDP 与 TCP 共用此号）。
pub const DEFAULT_STUN_TURN_PORT: u16 = 3478;

/// 服务器配置。
#[derive(Debug, Clone)]
pub struct Config {
    /// 额外的外部 STUN 服务器 URL 列表（可选；内置 STUN 已随进程启动）。
    pub stun_urls: Vec<String>,
    /// 额外的外部 TURN 服务器 URL 列表（可选；内置 TURN 已随进程启动）。
    pub turn_urls: Vec<String>,
    /// 外部 coturn `use-auth-secret` 模式下的共享密钥；缺省则不签发外部 TURN 凭证。
    pub turn_secret: Option<String>,
    /// TURN 临时凭证有效期（秒），内置与外部共用。
    pub turn_ttl: u64,
    /// 内置 STUN/TURN 监听的 UDP 端口；0 表示不监听（默认，单端口模式）。
    pub udp_port: u16,
    /// 内置 TURN over TCP 监听端口；0 表示不监听（默认，单端口模式）。
    /// 启用后可置于 nginx `stream` 之后，从而对外只暴露 TCP，穿越禁 UDP 的网络。
    pub tcp_port: u16,
    /// 中继对外宣告的 IP。缺省自动探测本机网卡 IP（局域网部署足够）；
    /// 服务器位于 NAT 之后对公网服务时需显式指定公网 IP。
    pub public_ip: Option<String>,
    /// 每个房间的成员上限（纯 Mesh 约束，默认 6）。
    pub max_peers: usize,
}

impl Config {
    /// 从环境变量构造。`stun_turn` 即 `--stun-turn`：为 false（默认）时不监听
    /// 3478，只保留 HTTP 端口；为 true 时 3478 成为 UDP/TCP 的默认端口。
    /// 两种情况下 `PPHUB_UDP_PORT` / `PPHUB_TCP_PORT` 都仍可单独覆盖，
    /// 因此「只开 TCP」写成 `--stun-turn` + `PPHUB_UDP_PORT=0` 即可。
    pub fn from_env(stun_turn: bool) -> Self {
        let default_port = if stun_turn { DEFAULT_STUN_TURN_PORT } else { 0 };
        Config {
            // 默认不依赖任何第三方 STUN：客户端能访问 pphub 即能用内置 STUN/TURN。
            stun_urls: split_csv(&env_or("PPHUB_STUN_URLS", "")),
            turn_urls: split_csv(&env_or("PPHUB_TURN_URLS", "")),
            turn_secret: std::env::var("PPHUB_TURN_SECRET")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            turn_ttl: std::env::var("PPHUB_TURN_TTL")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3600),
            udp_port: std::env::var("PPHUB_UDP_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(default_port),
            tcp_port: std::env::var("PPHUB_TCP_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(default_port),
            public_ip: std::env::var("PPHUB_PUBLIC_IP")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            max_peers: std::env::var("PPHUB_MAX_PEERS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(100), // 提高到 100，支持分层和树状拓扑
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// 以逗号切分并去除空白/空项。
fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}
