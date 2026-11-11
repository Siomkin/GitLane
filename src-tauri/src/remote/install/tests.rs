use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use base64::Engine;

use super::*;

#[cfg(unix)]
mod scripts;

/// Test-only key pair made with `tauri signer generate`; only the public half
/// and two signatures are kept.
const TEST_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDBEM0Y0N0RBMUU5M0MyNzMKUldSendwTWUya2MvRFdwNFAxa0szM3JIQk5TcGRMTGQyOUZRQTRKcCtwM28zUkUra2NyQ2ZZWWQK";
const PAYLOAD: &[u8] = b"gitlane agent test payload\n";
const PAYLOAD_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSendwTWUya2MvRFFwQ25tSVJZYlBnMStTMzZnYnFZSzFaRnN0eWV3RGhLSVlEdk4zY0ttZlN6RlRESEpmb3lXZWhqVW8wTElNc0dZemZJYjdYeFhqOUZHcjR0VjJCVlFjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzMzAxNDU3CWZpbGU6cGF5bG9hZC5iaW4KQ0R5REVUZEROd05wYngrS3dHQW1uQU0rMVVmeWE1WmtnNkUrMzJOU2UzMzBWcUJDV1RZTXNJclV2QXBLUkdYU01hZ3lGOXhPbEJwc0V5bmZUS1dTQ0E9PQo=";
/// `gzip` of `#!/bin/sh\necho test agent binary\n`, and its signature.
const AGENT_GZ: &str = "H4sIAAAAAAAA/1NW1E/KzNMvzuBKTc7IVyhJLS5RSExPzStRAAonFlVyAQCAr8s6IQAAAA==";
const AGENT_GZ_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSendwTWUya2MvRFk2dlU0Q1FFTWorSm5wQUFIQjMxQ2dKWVFGSHFEV291VVA4Nm9wS2doWTJqNkhiYlBXcUJyNUJraGtjeEhCVGVaUWd4SXF3VmJhblB3dzFWdDRLeGdnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzMzAxNTQ2CWZpbGU6YWdlbnQuZ3oKNjBWSGsxMGUzNFhPRnVQS2ZOTmNVYVl5bWtMSElMYW5xdDhsVkZBWUlqT3dacG5hMThsZ2dTcVJvZjNsY3RLNnVrU0VVc2EvVXcvM29PdFlzRVpYQmc9PQo=";

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("gitlane-install-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn agent_gz() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(AGENT_GZ)
        .unwrap()
}

#[test]
fn only_linux_x86_64_and_aarch64_are_supported() {
    assert_eq!(target_for("Linux x86_64").unwrap(), "linux-x86_64");
    assert_eq!(target_for("Linux aarch64").unwrap(), "linux-arm64");
    for other in ["Darwin arm64", "FreeBSD amd64", "Linux armv7l", ""] {
        let err = target_for(other).unwrap_err();
        assert_eq!(err.code.as_deref(), Some(UNSUPPORTED_PLATFORM));
        if !other.is_empty() {
            assert!(err.message.contains(other), "{}", err.message);
        }
    }
}

#[test]
fn the_probe_reads_platform_and_installed_version() {
    let current = parse_probe(&format!("Linux x86_64\ngitlane-agent {VERSION}\n"));
    assert_eq!(current.platform, "Linux x86_64");
    assert!(current.is_current());
    assert!(!parse_probe("Linux x86_64\ngitlane-agent 0.0.1\n").is_current());
    assert!(!parse_probe("Linux x86_64\n").is_current());
    // A login shell's banner before the mark is not the platform.
    let noisy = parse_probe(&format!(
        "Welcome to devbox\n--gitlane-probe--\nLinux aarch64\ngitlane-agent {VERSION}\n"
    ));
    assert_eq!(noisy.platform, "Linux aarch64");
    assert!(noisy.is_current());
}

#[test]
fn signatures_verify_only_for_the_signed_bytes_and_key() {
    verify(PAYLOAD, PAYLOAD_SIG, TEST_PUBLIC_KEY).unwrap();
    assert!(verify(b"tampered\n", PAYLOAD_SIG, TEST_PUBLIC_KEY).is_err());
    let release_key = release_public_key().unwrap();
    assert!(
        verify(PAYLOAD, PAYLOAD_SIG, &release_key).is_err(),
        "test key is not the release key"
    );
    assert!(verify(PAYLOAD, "not base64", TEST_PUBLIC_KEY).is_err());
}

#[test]
fn a_download_is_verified_unpacked_and_cached() {
    let cache = TempDir::new("cache");
    let fetches = Cell::new(0);
    let fetch = |url: &str, _: &dyn Fn(u8)| {
        fetches.set(fetches.get() + 1);
        assert!(
            url.contains(&format!("/v{VERSION}/gitlane-agent-linux-x86_64.gz")),
            "{url}"
        );
        Ok(if url.ends_with(".sig") {
            AGENT_GZ_SIG.as_bytes().to_vec()
        } else {
            agent_gz()
        })
    };
    let binary = agent_binary(
        "linux-x86_64",
        &cache.0,
        None,
        TEST_PUBLIC_KEY,
        &fetch,
        &|_| {},
    )
    .unwrap();
    assert_eq!(binary, b"#!/bin/sh\necho test agent binary\n");
    assert_eq!(fetches.get(), 2);
    let kept = cache.0.join(VERSION);
    assert_eq!(
        std::fs::read(kept.join("gitlane-agent-linux-x86_64.gz")).unwrap(),
        agent_gz()
    );
    assert!(kept.join("gitlane-agent-linux-x86_64.gz.sig").exists());

    let no_network =
        |_: &str, _: &dyn Fn(u8)| -> Result<Vec<u8>, String> { panic!("cache should be used") };
    let again = agent_binary(
        "linux-x86_64",
        &cache.0,
        None,
        TEST_PUBLIC_KEY,
        &no_network,
        &|_| {},
    )
    .unwrap();
    assert_eq!(again, binary);
}

#[test]
fn a_tampered_download_is_refused_and_not_cached() {
    let cache = TempDir::new("tampered");
    let fetch = |url: &str, _: &dyn Fn(u8)| {
        Ok(if url.ends_with(".sig") {
            AGENT_GZ_SIG.as_bytes().to_vec()
        } else {
            let mut gz = agent_gz();
            *gz.last_mut().unwrap() ^= 1;
            gz
        })
    };
    let err = agent_binary(
        "linux-x86_64",
        &cache.0,
        None,
        TEST_PUBLIC_KEY,
        &fetch,
        &|_| {},
    )
    .unwrap_err();
    assert_eq!(err.code.as_deref(), Some(AGENT_INSTALL));
    assert!(err.message.contains("signature"), "{}", err.message);
    assert!(
        std::fs::read_dir(&cache.0).unwrap().next().is_none(),
        "nothing cached"
    );
}

fn signed_fetch(fetches: &Cell<u32>) -> impl Fn(&str, &dyn Fn(u8)) -> Result<Vec<u8>, String> + '_ {
    move |url: &str, _: &dyn Fn(u8)| {
        fetches.set(fetches.get() + 1);
        Ok(if url.ends_with(".sig") {
            AGENT_GZ_SIG.as_bytes().to_vec()
        } else {
            agent_gz()
        })
    }
}

fn get_agent(cache: &Path, fetch: Fetch<'_>) -> Vec<u8> {
    agent_binary("linux-x86_64", cache, None, TEST_PUBLIC_KEY, fetch, &|_| {}).unwrap()
}

#[test]
fn a_changed_or_incomplete_cache_is_downloaded_again() {
    let signed = b"#!/bin/sh\necho test agent binary\n".to_vec();
    let cache = TempDir::new("changed");
    let kept = cache.0.join(VERSION);
    let fetches = Cell::new(0);
    get_agent(&cache.0, &signed_fetch(&fetches));

    std::fs::write(kept.join("gitlane-agent-linux-x86_64.gz"), b"planted").unwrap();
    assert_eq!(get_agent(&cache.0, &signed_fetch(&fetches)), signed);
    assert_eq!(fetches.get(), 4, "a changed archive is fetched again");
    assert_eq!(
        std::fs::read(kept.join("gitlane-agent-linux-x86_64.gz")).unwrap(),
        agent_gz(),
        "and overwritten"
    );

    std::fs::remove_file(kept.join("gitlane-agent-linux-x86_64.gz.sig")).unwrap();
    assert_eq!(get_agent(&cache.0, &signed_fetch(&fetches)), signed);
    assert_eq!(fetches.get(), 6, "a missing signature is fetched again");
}

#[test]
fn an_old_unpacked_cache_file_is_never_used() {
    let cache = TempDir::new("old-cache");
    let kept = cache.0.join(VERSION);
    std::fs::create_dir_all(&kept).unwrap();
    std::fs::write(kept.join("gitlane-agent-linux-x86_64"), b"planted").unwrap();
    let fetches = Cell::new(0);
    let binary = get_agent(&cache.0, &signed_fetch(&fetches));
    assert_eq!(binary, b"#!/bin/sh\necho test agent binary\n");
    assert_eq!(fetches.get(), 2);
}

#[test]
fn the_install_scripts_own_errors_are_install_errors() {
    let own = upload_error(
        "devbox",
        "",
        "Welcome\ngitlane-install: /home/u/.gitlane-server/1.0 belongs to another account; remove it on the server\n",
    );
    assert_eq!(own.code.as_deref(), Some(AGENT_INSTALL));
    assert!(
        own.message
            .ends_with("devbox: /home/u/.gitlane-server/1.0 belongs to another account; remove it on the server"),
        "{}",
        own.message
    );
    let ssh = upload_error(
        "devbox",
        "",
        "ssh: connect to host devbox port 22: Connection refused",
    );
    assert_ne!(ssh.code.as_deref(), Some(AGENT_INSTALL));
}

#[test]
fn the_override_path_skips_download_and_verification() {
    let dir = TempDir::new("override");
    let local = dir.0.join("gitlane-agent");
    std::fs::write(&local, b"local build").unwrap();
    let no_network = |_: &str, _: &dyn Fn(u8)| -> Result<Vec<u8>, String> { panic!("no download") };
    let bytes = agent_binary(
        "linux-x86_64",
        &dir.0,
        Some(local),
        "unused",
        &no_network,
        &|_| {},
    )
    .unwrap();
    assert_eq!(bytes, b"local build");
}
