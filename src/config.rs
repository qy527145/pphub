//! 运行时配置，全部来自环境变量，带合理默认值。

/// 服务器配置。
#[derive(Debug, Clone)]
pub struct Config {
    /// STUN 服务器 URL 列表（无需凭证）。
    pub stun_urls: Vec<String>,
    /// TURN 服务器 URL 列表（配合临时凭证）。
    pub turn_urls: Vec<String>,
    /// coturn `use-auth-secret` 模式下的共享密钥；缺省则不签发 TURN 凭证。
    pub turn_secret: Option<String>,
    /// TURN 临时凭证有效期（秒）。
    pub turn_ttl: u64,
    /// 每个房间的成员上限（纯 Mesh 约束，默认 6）。
    pub max_peers: usize,
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            stun_urls: split_csv(&env_or(
                "PPHUB_STUN_URLS",
                "stun:stun.l.google.com:19302",
            )),
            turn_urls: split_csv(&env_or("PPHUB_TURN_URLS", "")),
            turn_secret: std::env::var("PPHUB_TURN_SECRET")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            turn_ttl: std::env::var("PPHUB_TURN_TTL")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3600),
            max_peers: std::env::var("PPHUB_MAX_PEERS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(6),
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
