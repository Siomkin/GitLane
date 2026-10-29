//! The agent's wire format (remote-ssh-repos D5): one JSON value per line over
//! the `ssh` session's stdio.
//!
//! - hello, sent first: `{"hello":{"version","protocol","git","gitError","home"}}`
//! - request: `{"id":n,"cmd":"…","args":{…}}`
//! - response: `{"id":n,"ok":…}` or `{"id":n,"err":<CommandError>}`
//! - event: `{"id":n,"event":"…","payload":…}` (progress of request `n`)
//! - a line that is not a request: `{"error":"…"}`
//!
//! A frame whose JSON exceeds [`COMPRESS_ABOVE`] travels as
//! `{"z":"<base64 zlib of the frame>"}`: over a real link the graph's size, not
//! the agent's work, decides how long a call takes, and it compresses 3–8×.

use std::io::{Read, Write};

use base64::Engine;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
#[cfg(any(feature = "agent", test))]
use serde::Deserialize;
use serde_json::{json, Value};

#[cfg(any(feature = "agent", test))]
use crate::commands::CommandError;

/// Bumped on any incompatible frame change. The agent is installed per app
/// version, so this only guards against a hand-installed mismatch.
pub const PROTOCOL: u32 = 1;

/// Frames larger than this many bytes of JSON are compressed.
pub const COMPRESS_ABOVE: usize = 64 * 1024;

/// One request line from the desktop.
#[cfg(any(feature = "agent", test))]
#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub cmd: String,
    #[serde(default)]
    pub args: Value,
}

/// The first frame: who is answering, and whether its git can be used.
#[cfg(any(feature = "agent", test))]
pub fn hello(git: Option<String>, git_error: Option<CommandError>, home: Option<String>) -> Value {
    json!({ "hello": {
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL,
        "git": git,
        "gitError": git_error.map(CommandError::redacted),
        "home": home,
    }})
}

/// The answer to request `id`. Errors are redacted again here as defense in
/// depth: everything on this wire may end up in the desktop's UI.
#[cfg(any(feature = "agent", test))]
pub fn response(id: u64, result: Result<Value, CommandError>) -> Value {
    match result {
        Ok(ok) => json!({ "id": id, "ok": ok }),
        Err(err) => json!({ "id": id, "err": err.redacted() }),
    }
}

/// A progress event for request `id`, under a declared `crate::events` name.
#[cfg(any(feature = "agent", test))]
pub fn event(id: u64, name: &str, payload: Value) -> Value {
    json!({ "id": id, "event": name, "payload": payload })
}

/// A line that could not be read as a request.
pub fn protocol_error(message: &str) -> Value {
    json!({ "error": crate::redact::redact_secrets(message) })
}

/// Serialize a frame as one line, compressing it when it is large.
pub fn encode(frame: &Value) -> Vec<u8> {
    let mut text = serde_json::to_vec(frame).unwrap_or_else(|e| {
        serde_json::to_vec(&protocol_error(&format!("unserializable frame: {e}"))).unwrap()
    });
    if text.len() > COMPRESS_ABOVE {
        let mut zlib = ZlibEncoder::new(Vec::new(), Compression::default());
        // Writing to a Vec cannot fail.
        zlib.write_all(&text).unwrap();
        let packed = base64::engine::general_purpose::STANDARD.encode(zlib.finish().unwrap());
        text = serde_json::to_vec(&json!({ "z": packed })).unwrap();
    }
    text.push(b'\n');
    text
}

/// Parse one line, undoing [`encode`]'s compression.
pub fn decode(line: &[u8]) -> Result<Value, String> {
    let frame: Value = serde_json::from_slice(line).map_err(|e| format!("bad frame: {e}"))?;
    let Some(packed) = frame.get("z").and_then(Value::as_str) else {
        return Ok(frame);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(packed)
        .map_err(|e| format!("bad compressed frame: {e}"))?;
    let mut text = Vec::new();
    ZlibDecoder::new(bytes.as_slice())
        .read_to_end(&mut text)
        .map_err(|e| format!("bad compressed frame: {e}"))?;
    serde_json::from_slice(&text).map_err(|e| format!("bad frame: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_reports_an_unusable_git_as_its_error() {
        let token = format!("ghp_{}", "c".repeat(36));
        let gate = CommandError::from(format!(
            "Git 2.20.0 is too old (GitLane needs 2.36.0 or newer). See https://{token}@example.com"
        ));
        let frame = hello(
            Some("git version 2.20.0".into()),
            Some(gate),
            Some("/home/u".into()),
        );
        let hello = &frame["hello"];
        assert_eq!(hello["protocol"], PROTOCOL);
        assert_eq!(hello["git"], "git version 2.20.0");
        assert_eq!(hello["home"], "/home/u");
        let error = hello["gitError"].to_string();
        assert!(
            error.contains("too old") && !error.contains(&token),
            "{error}"
        );
    }

    #[test]
    fn decode_rejects_garbage_without_panicking() {
        assert!(decode(b"not json").is_err());
        assert!(decode(b"{\"z\":\"!!!\"}").is_err());
    }
}
