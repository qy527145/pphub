//! TURN/STUN 临时凭证签发（coturn `use-auth-secret` / TURN REST API 模式）。
//!
//! 生成规则：
//!   username   = "<过期时间戳>"
//!   credential = base64( HMAC-SHA1( secret, username ) )
//! 共享密钥只存在于服务端，绝不下发前端。

use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::Config;
use crate::protocol::IceServer;

type HmacSha1 = Hmac<Sha1>;

/// 根据配置构建下发给前端的 ICE 服务器列表，返回 `(ice_servers, ttl)`。
pub fn build_ice_servers(cfg: &Config) -> (Vec<IceServer>, u64) {
    let mut servers = Vec::new();

    if !cfg.stun_urls.is_empty() {
        servers.push(IceServer {
            urls: cfg.stun_urls.clone(),
            username: None,
            credential: None,
        });
    }

    if !cfg.turn_urls.is_empty() {
        match &cfg.turn_secret {
            Some(secret) => {
                let (username, credential) = make_credentials(secret, cfg.turn_ttl);
                servers.push(IceServer {
                    urls: cfg.turn_urls.clone(),
                    username: Some(username),
                    credential: Some(credential),
                });
            }
            // 未配置密钥：仍下发 TURN URL，但无凭证（通常不可用，仅为可观测性）。
            None => servers.push(IceServer {
                urls: cfg.turn_urls.clone(),
                username: None,
                credential: None,
            }),
        }
    }

    (servers, cfg.turn_ttl)
}

fn make_credentials(secret: &str, ttl: u64) -> (String, String) {
    let expiry = now_secs().saturating_add(ttl);
    let username = expiry.to_string();

    let mut mac =
        HmacSha1::new_from_slice(secret.as_bytes()).expect("HMAC accepts key of any size");
    mac.update(username.as_bytes());
    let credential = STANDARD.encode(mac.finalize().into_bytes());

    (username, credential)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
