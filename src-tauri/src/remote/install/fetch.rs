//! Getting the agent onto this computer: download a release asset with a
//! bounded size, and verify a signed `.gz` against the updater's key before
//! unpacking it.

use crate::num::u64_from_usize;
use std::io::Read;
use std::time::Duration;

use base64::Engine;
use flate2::read::GzDecoder;

/// The updater's minisign key signs the agent too: one trust root.
const TAURI_CONF: &str = include_str!("../../../tauri.conf.json");

/// A compressed agent larger than this is refused rather than buffered.
const MAX_DOWNLOAD: u64 = 64 * 1024 * 1024;

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

/// The updater's minisign public key from `tauri.conf.json`.
pub fn release_public_key() -> Result<String, String> {
    let conf: serde_json::Value =
        serde_json::from_str(TAURI_CONF).map_err(|e| format!("tauri.conf.json: {e}"))?;
    conf.pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "tauri.conf.json has no updater public key".into())
}

/// Verify `packed` against `sig`, then unpack it.
pub(super) fn verified_unpack(
    packed: &[u8],
    sig: &[u8],
    public_key: &str,
) -> Result<Vec<u8>, String> {
    verify(packed, &String::from_utf8_lossy(sig), public_key)?;
    let mut binary = Vec::new();
    GzDecoder::new(packed)
        .read_to_end(&mut binary)
        .map_err(|e| format!("unpacking: {e}"))?;
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
            let percent = (u64_from_usize(bytes.len()) * 100 / total).min(100);
            progress(u8::try_from(percent).unwrap_or(100));
        }
    }
    Ok(bytes)
}
