fn main() {
    // The headless `agent` build has no Tauri app to configure.
    #[cfg(feature = "desktop")]
    desktop();
}

#[cfg(feature = "desktop")]
fn desktop() {
    // tauri-build links its app manifest (Common Controls v6, which the dialog
    // plugin needs) into binaries only, so `cargo test` executables die on
    // Windows with STATUS_ENTRYPOINT_NOT_FOUND. Embed the same manifest
    // through the linker instead, which covers every target.
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let mut windows = tauri_build::WindowsAttributes::new();
    if msvc {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest = std::env::current_dir()
            .unwrap()
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
