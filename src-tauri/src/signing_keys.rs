//! Discovery of the user's existing signing keys for the profile editor's key
//! picker: GPG secret keys (via `gpg --list-secret-keys`) and SSH public keys
//! (`~/.ssh/*.pub`).
//!
//! References only — GPG key ids and SSH public-key paths. This never reads,
//! returns, or stores private key material or passphrases; unlocking stays with
//! gpg-agent / ssh-agent / the OS keychain at use time.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::git::types::SigningKey;

/// All signing keys available locally, GPG first then SSH.
pub fn list() -> Vec<SigningKey> {
    let mut keys = gpg_secret_keys();
    keys.extend(ssh_public_keys());
    keys
}

fn gpg_secret_keys() -> Vec<SigningKey> {
    let output = Command::new("gpg")
        .args(["--list-secret-keys", "--keyid-format=long", "--with-colons"])
        .env("PATH", crate::shell::path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(out) if out.status.success() => parse_gpg_secret_keys(&String::from_utf8_lossy(&out.stdout)),
        _ => Vec::new(),
    }
}

/// Parse `gpg --list-secret-keys --with-colons` output. Each `sec` record opens
/// a key (field index 4 is the long key id); the first following `uid` record
/// (field index 9) is its label. Subkeys (`ssb`) are ignored — we offer primary
/// keys only.
fn parse_gpg_secret_keys(text: &str) -> Vec<SigningKey> {
    let mut keys = Vec::new();
    let mut pending: Option<String> = None;
    for line in text.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        match fields.first().copied() {
            Some("sec") => {
                pending = fields.get(4).filter(|s| !s.is_empty()).map(|s| s.to_string());
            }
            Some("uid") => {
                if let Some(value) = pending.take() {
                    let label = fields
                        .get(9)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| value.clone());
                    keys.push(SigningKey {
                        value,
                        label,
                        format: "openpgp".into(),
                    });
                }
            }
            _ => {}
        }
    }
    keys
}

fn ssh_public_keys() -> Vec<SigningKey> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let dir = Path::new(&home).join(".ssh");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pub") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(label) = ssh_label(content.lines().next().unwrap_or("")) {
            keys.push(SigningKey {
                value: path.to_string_lossy().to_string(),
                label,
                format: "ssh".into(),
            });
        }
    }
    keys.sort_by(|a, b| a.label.cmp(&b.label));
    keys
}

/// Derive a display label from an SSH public-key line ("ssh-ed25519 AAAA… comment").
/// Returns `None` for lines that don't look like a public key.
fn ssh_label(line: &str) -> Option<String> {
    let line = line.trim();
    let mut parts = line.splitn(3, ' ');
    let kind = parts.next().unwrap_or("");
    if !(kind.starts_with("ssh-") || kind.starts_with("sk-") || kind.starts_with("ecdsa-")) {
        return None;
    }
    parts.next()?; // skip the base64 blob
    let comment = parts.next().unwrap_or("").trim();
    Some(if comment.is_empty() {
        kind.to_string()
    } else {
        format!("{comment} · {kind}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gpg_colon_listing_into_primary_keys() {
        let sample = "\
sec:u:4096:1:ABCD1234EF567890:1700000000:::u:::scESC:::::::::
fpr:::::::::1111222233334444AAAABBBBCCCCDDDDEEEE0000:
grp:::::::::ZZZ:
uid:u::::1700000000::HASH::Ada Lovelace <ada@example.com>::::::::::0:
ssb:u:4096:1:DEADBEEFDEADBEEF:1700000000::::::s:::::::
fpr:::::::::5555666677778888:
sec:u:255:22:99AA88BB77CC66DD:1700000000:::u:::scESC:::::::::
uid:u::::1700000000::HASH2::Grace Hopper <grace@example.com>::::::::::0:
";
        let keys = parse_gpg_secret_keys(sample);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].value, "ABCD1234EF567890");
        assert_eq!(keys[0].label, "Ada Lovelace <ada@example.com>");
        assert_eq!(keys[0].format, "openpgp");
        assert_eq!(keys[1].value, "99AA88BB77CC66DD");
        assert_eq!(keys[1].label, "Grace Hopper <grace@example.com>");
    }

    #[test]
    fn ssh_label_reads_type_and_comment() {
        assert_eq!(
            ssh_label("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 ada@laptop"),
            Some("ada@laptop · ssh-ed25519".into()),
        );
        assert_eq!(ssh_label("ssh-rsa AAAAB3Nza"), Some("ssh-rsa".into()));
        assert_eq!(ssh_label("not a key"), None);
        assert_eq!(ssh_label(""), None);
    }
}
