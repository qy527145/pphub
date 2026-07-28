//! 前端静态资源：编译期把 `web/dist` 嵌入二进制（debug 构建下运行时读盘，便于开发）。

use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

/// 兜底处理器：优先返回匹配到的静态文件，否则回退到 index.html（SPA 路由）。
/// `/ws`、`/healthz` 由显式路由处理，不会走到这里。
pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let candidate = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = Assets::get(candidate) {
        return serve(candidate, file);
    }
    if let Some(index) = Assets::get("index.html") {
        return serve("index.html", index);
    }
    (
        StatusCode::NOT_FOUND,
        "前端未构建：请先在 web/ 执行 `npm install && npm run build`",
    )
        .into_response()
}

fn serve(path: &str, file: rust_embed::EmbeddedFile) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // index.html 需实时更新；带内容哈希的静态资源可长缓存。
    let cache = if path == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_string()),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        file.data,
    )
        .into_response()
}
