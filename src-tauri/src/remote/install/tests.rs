use std::cell::Cell;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use base64::Engine;

use super::*;

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
    assert_eq!(
        target_for("Linux x86_64").unwrap(),
        "x86_64-unknown-linux-musl"
    );
    assert_eq!(
        target_for("Linux aarch64").unwrap(),
        "aarch64-unknown-linux-musl"
    );
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
            url.contains(&format!(
                "/v{VERSION}/gitlane-agent-x86_64-unknown-linux-musl.gz"
            )),
            "{url}"
        );
        Ok(if url.ends_with(".sig") {
            AGENT_GZ_SIG.as_bytes().to_vec()
        } else {
            agent_gz()
        })
    };
    let binary = agent_binary(
        "x86_64-unknown-linux-musl",
        &cache.0,
        None,
        TEST_PUBLIC_KEY,
        &fetch,
        &|_| {},
    )
    .unwrap();
    assert_eq!(binary, b"#!/bin/sh\necho test agent binary\n");
    assert_eq!(fetches.get(), 2);

    let no_network =
        |_: &str, _: &dyn Fn(u8)| -> Result<Vec<u8>, String> { panic!("cache should be used") };
    let again = agent_binary(
        "x86_64-unknown-linux-musl",
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
        "x86_64-unknown-linux-musl",
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

#[test]
fn the_override_path_skips_download_and_verification() {
    let dir = TempDir::new("override");
    let local = dir.0.join("gitlane-agent");
    std::fs::write(&local, b"local build").unwrap();
    let no_network = |_: &str, _: &dyn Fn(u8)| -> Result<Vec<u8>, String> { panic!("no download") };
    let bytes = agent_binary(
        "x86_64-unknown-linux-musl",
        &dir.0,
        Some(local),
        "unused",
        &no_network,
        &|_| {},
    )
    .unwrap();
    assert_eq!(bytes, b"local build");
}

/// Run a remote command string the way the user's login shell would, with
/// `home` as `$HOME`.
fn run_remote(home: &Path, command: &str, stdin: &[u8]) -> std::process::Output {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .env("HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

fn fake_agent() -> Vec<u8> {
    format!("#!/bin/sh\necho gitlane-agent {VERSION}\n").into_bytes()
}

#[cfg(unix)]
#[test]
fn the_install_script_installs_checks_and_prunes() {
    let home = TempDir::new("home");
    let base = home.0.join(".gitlane-server");
    for (old, stamp) in [("0.0.1", "202001010000"), ("0.0.2", "202101010000")] {
        std::fs::create_dir_all(base.join(old)).unwrap();
        Command::new("touch")
            .args(["-t", stamp])
            .arg(base.join(old))
            .status()
            .unwrap();
    }
    let agent = fake_agent();
    let out = run_remote(&home.0, &remote_sh(&install_script(agent.len())), &agent);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains(&format!("gitlane-agent {VERSION}")));
    assert!(base.join(VERSION).join("gitlane-agent").exists());
    assert!(!base.join(VERSION).join(".gitlane-agent.partial").exists());
    assert!(
        base.join("0.0.2").exists(),
        "the newest previous version is kept"
    );
    assert!(!base.join("0.0.1").exists(), "older versions are pruned");

    let probe = run_remote(&home.0, &probe_script(), b"");
    let found = parse_probe(&String::from_utf8_lossy(&probe.stdout));
    assert!(found.is_current(), "{found:?}");
}

#[cfg(unix)]
#[test]
fn a_truncated_upload_installs_nothing() {
    let home = TempDir::new("truncated");
    let agent = fake_agent();
    let out = run_remote(
        &home.0,
        &remote_sh(&install_script(agent.len() + 10)),
        &agent,
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("upload truncated"));
    let dir = home.0.join(".gitlane-server").join(VERSION);
    assert!(!dir.join("gitlane-agent").exists());
    assert!(!dir.join(".gitlane-agent.partial").exists());
}
