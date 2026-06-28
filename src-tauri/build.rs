fn main() {
    // The update channel is baked in at compile time via `PORTCODE_CHANNEL`
    // (see `update::channel`). Tell Cargo to rebuild when it changes so a
    // staging build and a stable build don't share a stale cached artifact.
    println!("cargo:rerun-if-env-changed=PORTCODE_CHANNEL");
    tauri_build::build()
}
