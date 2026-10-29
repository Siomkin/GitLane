fn main() {
    // The headless `agent` build has no Tauri app to configure.
    #[cfg(feature = "desktop")]
    tauri_build::build()
}
