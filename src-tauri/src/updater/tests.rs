use super::{endpoint_for, release_notes::RELEASES_API, BETA_ENDPOINT, STABLE_ENDPOINT};

/// The single updater endpoint a Tauri config file bakes in.
fn config_endpoint(config: &str) -> String {
    let config: serde_json::Value = serde_json::from_str(config).expect("config is JSON");
    let endpoints = config["plugins"]["updater"]["endpoints"]
        .as_array()
        .expect("plugins.updater.endpoints");
    assert_eq!(endpoints.len(), 1, "one endpoint per channel");
    endpoints[0].as_str().expect("endpoint string").to_owned()
}

// The command itself needs a live Tauri runtime, so it isn't unit-testable
// here; guard the thing that can silently drift — the manifest URLs, read
// from the config files a build bakes them from (a mismatch sends one
// channel's runtime check somewhere its build never looks).
#[test]
fn beta_endpoint_mirrors_tauri_beta_conf() {
    assert_eq!(
        BETA_ENDPOINT,
        config_endpoint(include_str!("../../tauri.beta.conf.json"))
    );
    assert!(BETA_ENDPOINT.ends_with("/releases/download/beta/latest.json"));
}

#[test]
fn stable_endpoint_mirrors_tauri_conf() {
    assert_eq!(
        STABLE_ENDPOINT,
        config_endpoint(include_str!("../../tauri.conf.json"))
    );
    assert!(STABLE_ENDPOINT.ends_with("/releases/latest/download/latest.json"));
}

// The toggle must resolve to a *different* endpoint each way — the regression
// the review caught was `beta = false` silently reusing the build default.
#[test]
fn each_channel_selects_its_own_endpoint() {
    assert_eq!(endpoint_for(true), BETA_ENDPOINT);
    assert_eq!(endpoint_for(false), STABLE_ENDPOINT);
    assert_ne!(endpoint_for(true), endpoint_for(false));
    assert!(STABLE_ENDPOINT.starts_with("https://"));
    assert!(BETA_ENDPOINT.starts_with("https://"));
}

/// `owner/repo` of the stable manifest's repository.
fn manifest_repository() -> &'static str {
    STABLE_ENDPOINT
        .strip_prefix("https://github.com/")
        .and_then(|rest| rest.split("/releases/").next())
        .expect("owner/repo in the stable endpoint")
}

// The notes come from the same repository the stable manifest points at.
#[test]
fn releases_api_names_the_manifest_repository() {
    assert_eq!(
        RELEASES_API,
        format!(
            "https://api.github.com/repos/{}/releases",
            manifest_repository()
        )
    );
}

// The dialog's "View on GitHub" links live in the frontend seam; keep them on
// the same repository too.
#[test]
fn frontend_releases_link_names_the_manifest_repository() {
    let seam = include_str!("../../../src/lib/updater.ts");
    let link = format!(
        "RELEASES_PAGE_URL = \"https://github.com/{}/releases\"",
        manifest_repository()
    );
    assert!(seam.contains(&link), "src/lib/updater.ts must hold {link}");
}
