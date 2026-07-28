fn main() {
    // rust-embed 要求 web/dist 在编译期存在；前端未构建时创建空目录即可通过编译，
    // 运行时静态处理器会提示「前端未构建」。改动前端后执行 `npm --prefix web run build`。
    let _ = std::fs::create_dir_all("web/dist");
    println!("cargo:rerun-if-changed=web/dist");
}
