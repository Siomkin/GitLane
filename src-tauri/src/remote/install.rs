//! Put the matching agent on a host before connecting (remote-ssh-repos D7):
//! check what is there with one `ssh` exec, fetch this version's signed agent
//! for the host's platform (or reuse the verified cache), upload it over `ssh`,
//! and prune old versions. The server needs only `sh`, `git` and sshd.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::Engine;
use flate2::read::GzDecoder;

use super::connect::{agent_path, ssh_command};
use super::locator::Locator;
use super::ssh_errors::{self, AGENT_INSTALL, UNSUPPORTED_PLATFORM};
use crate::git::types::CommandError;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Where releases publish `gitlane-agent-<target>.gz` and its `.sig`.
const RELEASE_DOWNLOADS: &str = "https://github.com/Siomkin/GitLane/releases/download";

/// The updater's minisign key signs the agent too: one trust root.
const TAURI_CONF: &str = include_str!("../../tauri.conf.json");

/// A compressed agent larger than this is refused rather than buffered.
const MAX_DOWNLOAD: u64 = 64 * 1024 * 1024;

/// Progress the UI can show while a host is prepared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Downloading(u8),
    Uploading(u8),
}

/// Fetch `url`'s bytes, reporting percent done.
pub type Fetch<'a> = &'a dyn Fn(&str, &dyn Fn(u8)) -> Result<Vec<u8>, String>;

/// What one `ssh` exec found on the host.
#[derive(Debug, PartialEq, Eq)]
pub struct Probe {
    /// `uname -sm`, e.g. `Linux x86_64`.
    pub platform: String,
    /// The installed agent's `--version` line for this app version, if any.
    pub installed: Option<String>,
}

impl Probe {
    pub fn is_current(&self) -> bool {
        self.installed.as_deref() == Some(format!("gitlane-agent {VERSION}").as_str())
    }
}

/// Run `script` through `sh -c` on the host: the user's login shell may be
/// fish or zsh, so everything after it is plain POSIX `sh`.
pub(super) fn remote_sh(script: &str) -> String {
    format!("sh -c '{}'", script.replace('\'', r"'\''"))
}

/// Printed before the probe's answer, so a shell that prints a banner first
/// can't be read as the platform.
const PROBE_MARK: &str = "--gitlane-probe--";

pub fn probe_script() -> String {
    remote_sh(&format!(
        "echo {PROBE_MARK}; uname -sm; \"$HOME/{}\" --version 2>/dev/null || true",
        agent_path()
    ))
}

pub fn parse_probe(stdout: &str) -> Probe {
    // Everything after the mark; all of it when a shell somehow ate the mark.
    let answer = stdout
        .split_once(PROBE_MARK)
        .map_or(stdout, |(_, after)| after);
    let mut lines = answer.lines().map(str::trim).filter(|l| !l.is_empty());
    let platform = lines.next().unwrap_or_default().to_string();
    let installed = lines
        .find(|l| l.starts_with("gitlane-agent "))
        .map(str::to_string);
    Probe {
        platform,
        installed,
    }
}

pub fn probe(locator: &Locator) -> Result<Probe, CommandError> {
    let output = ssh_command(locator)
        .arg(probe_script())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            ssh_errors::unavailable(
                ssh_errors::UNREACHABLE,
                format!("Could not start ssh for {}: {e}", locator.display_host()),
            )
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ssh_errors::classify(locator.display_host(), &stderr));
    }
    Ok(parse_probe(&stdout))
}

/// The agent build for a `uname -sm` platform. Only Linux x86_64 and aarch64
/// are supported (`remote/ssh-repos`).
pub fn target_for(platform: &str) -> Result<&'static str, CommandError> {
    let mut words = platform.split_whitespace();
    match (words.next(), words.next()) {
        (Some("Linux"), Some("x86_64" | "amd64")) => Ok("x86_64-unknown-linux-musl"),
        (Some("Linux"), Some("aarch64" | "arm64")) => Ok("aarch64-unknown-linux-musl"),
        _ => Err(ssh_errors::unavailable(
            UNSUPPORTED_PLATFORM,
            format!(
                "GitLane can open repositories on Linux x86_64 and aarch64 servers; this one is {}.",
                if platform.is_empty() { "unknown" } else { platform }
            ),
        )),
    }
}

/// Verify `data` against a Tauri-style `.sig` (base64 of a minisign signature)
/// with a base64 minisign public key, exactly as the updater does.
pub fn verify(data: &[u8], sig: &str, public_key: &str) -> Result<(), String> {
    let decode = |text: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(text.trim())
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    };
    let key = decode(public_key)
        .and_then(|k| minisign_verify::PublicKey::decode(&k).ok())
        .ok_or("the release public key is unreadable")?;
    let sig = decode(sig)
        .and_then(|s| minisign_verify::Signature::decode(&s).ok())
        .ok_or("the agent signature is unreadable")?;
    key.verify(data, &sig, true)
        .map_err(|_| "the agent's signature does not match".to_string())
}

pub fn release_public_key() -> Result<String, String> {
    let conf: serde_json::Value =
        serde_json::from_str(TAURI_CONF).map_err(|e| format!("tauri.conf.json: {e}"))?;
    conf.pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "tauri.conf.json has no updater public key".into())
}

/// This version's agent for `target`: the `GITLANE_AGENT_PATH` file when given
/// (development builds), else the verified cache, else a signed download that is
/// verified, unpacked and cached under `cache_dir`.
pub fn agent_binary(
    target: &str,
    cache_dir: &Path,
    override_path: Option<PathBuf>,
    public_key: &str,
    fetch: Fetch<'_>,
    progress: &dyn Fn(Step),
) -> Result<Vec<u8>, CommandError> {
    let install_error = |why: String| {
        ssh_errors::unavailable(
            AGENT_INSTALL,
            format!("Could not get the GitLane agent: {why}"),
        )
    };
    if let Some(path) = override_path {
        return std::fs::read(&path).map_err(|e| install_error(format!("{}: {e}", path.display())));
    }
    let cached = cache_dir
        .join(VERSION)
        .join(format!("gitlane-agent-{target}"));
    if let Ok(bytes) = std::fs::read(&cached) {
        return Ok(bytes);
    }
    let asset = format!("{RELEASE_DOWNLOADS}/v{VERSION}/gitlane-agent-{target}.gz");
    let sig = fetch(&format!("{asset}.sig"), &|_| {}).map_err(install_error)?;
    let packed = fetch(&asset, &|pct| progress(Step::Downloading(pct))).map_err(install_error)?;
    verify(&packed, &String::from_utf8_lossy(&sig), public_key).map_err(install_error)?;
    let mut binary = Vec::new();
    GzDecoder::new(packed.as_slice())
        .read_to_end(&mut binary)
        .map_err(|e| install_error(format!("unpacking: {e}")))?;
    // Best effort: a failed cache write only means downloading again next time.
    if let Some(dir) = cached.parent() {
        let partial = cached.with_extension("partial");
        let _ = std::fs::create_dir_all(dir)
            .and_then(|()| std::fs::write(&partial, &binary))
            .and_then(|()| std::fs::rename(&partial, &cached));
    }
    Ok(binary)
}

/// Download `url` over HTTPS with a bounded size and timeout.
pub fn download(url: &str, progress: &dyn Fn(u8)) -> Result<Vec<u8>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(300)))
        .user_agent("GitLane")
        .build()
        .into();
    let mut response = agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let mut reader = response
        .body_mut()
        .with_config()
        .limit(MAX_DOWNLOAD)
        .reader();
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut chunk).map_err(|e| format!("{url}: {e}"))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(total) = total.filter(|t| *t > 0) {
            progress(((bytes.len() as u64 * 100) / total).min(100) as u8);
        }
    }
    Ok(bytes)
}

/// The script that installs `size` bytes from stdin as this version's agent,
/// checks it runs, and prunes every other version but the newest previous one
/// and any agent still running.
pub fn install_script(size: usize) -> String {
    let dir = agent_path();
    let dir = dir.trim_end_matches("/gitlane-agent");
    format!(
        r#"set -e
base="$HOME/.gitlane-server"
dir="$HOME/{dir}"
part="$dir/.gitlane-agent.partial"
mkdir -p "$dir"
cat > "$part"
got=$(wc -c < "$part" | tr -d " ")
if [ "$got" != "{size}" ]; then rm -f "$part"; echo "upload truncated: $got of {size} bytes" >&2; exit 3; fi
chmod 700 "$part"
mv -f "$part" "$dir/gitlane-agent"
"$dir/gitlane-agent" --version
keep=$(ls -1t "$base" | grep -vx "{VERSION}" | head -n 1 || true)
for old in "$base"/*; do
  name=${{old##*/}}
  if [ "$name" = "{VERSION}" ] || [ "$name" = "$keep" ]; then continue; fi
  for exe in /proc/[0-9]*/exe; do
    if [ "$(readlink "$exe" 2>/dev/null)" = "$old/gitlane-agent" ]; then continue 2; fi
  done
  rm -rf "$old"
done"#
    )
}

/// Upload `binary` to `locator`'s host as this version's agent.
pub fn upload(
    locator: &Locator,
    binary: &[u8],
    progress: &dyn Fn(Step),
) -> Result<(), CommandError> {
    let host = locator.display_host();
    let failed = |why: String| {
        ssh_errors::unavailable(
            AGENT_INSTALL,
            format!("Could not install the GitLane agent on {host}: {why}"),
        )
    };
    let mut child = ssh_command(locator)
        .arg(remote_sh(&install_script(binary.len())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| failed(e.to_string()))?;
    if let Some(mut stdin) = child.stdin.take() {
        for (i, chunk) in binary.chunks(256 * 1024).enumerate() {
            if stdin.write_all(chunk).is_err() {
                break; // ssh exited; its stderr says why
            }
            let sent = ((i + 1) * 256 * 1024).min(binary.len());
            progress(Step::Uploading((sent * 100 / binary.len().max(1)) as u8));
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| failed(e.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && stdout.contains(&format!("gitlane-agent {VERSION}")) {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stdout.trim().is_empty() && !stderr.contains("upload truncated") {
        return Err(ssh_errors::classify(host, &stderr));
    }
    Err(failed(crate::redact::redact_secrets(stderr.trim())))
}

/// Make sure this version's agent is on `locator`'s host. Returns without
/// uploading when it already is.
pub fn ensure_installed(
    locator: &Locator,
    cache_dir: &Path,
    progress: &dyn Fn(Step),
) -> Result<(), CommandError> {
    let found = probe(locator)?;
    if found.is_current() {
        return Ok(());
    }
    let target = target_for(&found.platform)?;
    let override_path = std::env::var_os("GITLANE_AGENT_PATH").map(PathBuf::from);
    let public_key =
        release_public_key().map_err(|why| ssh_errors::unavailable(AGENT_INSTALL, why))?;
    let binary = agent_binary(
        target,
        cache_dir,
        override_path,
        &public_key,
        &download,
        progress,
    )?;
    upload(locator, &binary, progress)
}

#[cfg(test)]
mod tests;
