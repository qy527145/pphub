//! pphub —— 免安装、纯浏览器的 P2P 直连协作应用（单二进制，前端嵌入）。
//!
//! 本进程同时承担两个角色：
//!   1. 托管嵌入的前端静态资源（`web/dist`）；
//!   2. 充当信令服务器：仅交换 SDP / ICE candidate 与签发 TURN 凭证，
//!      **不中转任何业务数据**（聊天、文件、媒体一律走 P2P 通道）。

mod assets;
mod config;
mod protocol;
mod room;
mod turn;
mod ws;

use std::sync::Arc;

use axum::routing::get;
use axum::{Router, response::IntoResponse};
use clap::Parser;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::assets::static_handler;
use crate::config::Config;
use crate::room::Rooms;

/// 命令行参数。STUN/TURN 等其余配置仍走环境变量（见 [`Config`]）。
#[derive(Parser)]
#[command(name = "pphub", version, about = "免安装 P2P 直连协作（单二进制，前端嵌入）")]
struct Cli {
    /// 监听主机
    #[arg(short = 'H', long, default_value = "0.0.0.0", env = "PPHUB_HOST")]
    host: String,
    /// 监听端口
    #[arg(short = 'p', long, default_value_t = 8848, env = "PPHUB_PORT")]
    port: u16,
}

/// 通过 axum `State` 共享的应用状态。
#[derive(Clone)]
pub struct AppState {
    pub rooms: Arc<Rooms>,
    pub config: Arc<Config>,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    let config = Config::from_env();
    let bind = format!("{}:{}", cli.host, cli.port);
    tracing::info!(
        %bind,
        max_peers = config.max_peers,
        stun = ?config.stun_urls,
        turn = ?config.turn_urls,
        turn_auth = config.turn_secret.is_some(),
        "启动 pphub"
    );

    let state = AppState {
        rooms: Arc::new(Rooms::new(config.max_peers)),
        config: Arc::new(config),
    };

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws::ws_handler))
        .fallback(static_handler)
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| panic!("无法绑定 {bind}: {e}"));
    tracing::info!("pphub 已启动: http://{bind}");

    axum::serve(listener, app).await.expect("HTTP 服务异常退出");
}

async fn healthz() -> impl IntoResponse {
    "ok"
}
