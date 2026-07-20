//! Discovery of the user's existing signing keys for the profile editor's key
//! picker: GPG secret keys (via `gpg --list-secret-keys`) and SSH public keys
//! (`~/.ssh/*.pub`).
//!
//! References only — full GPG fingerprints and SSH public-key paths. This never
//! reads, returns, or stores private key material or passphrases; unlocking stays
//! with gpg-agent / ssh-agent / the OS keychain at use time.

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
    let mut cmd = Command::new("gpg");
    cmd.args(["--list-secret-keys", "--with-colons", "--with-fingerprint"])
        .env("PATH", crate::shell::path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::shell::hide_console(&mut cmd);
    let output = cmd.output();
    match output {
        Ok(out) if out.status.success() => {
            parse_gpg_secret_keys(&String::from_utf8_lossy(&out.stdout))
        }
        _ => Vec::new(),
    }
}

/// Parse `gpg --list-secret-keys --with-colons` output. Each `sec` record opens
/// a primary key and its immediately following `fpr` record supplies the full
/// fingerprint written to `user.signingkey`; the first following `uid` record is
/// its label. Subkey (`ssb`) fingerprints are ignored.
fn parse_gpg_secret_keys(text: &str) -> Vec<SigningKey> {
    let mut keys = Vec::new();
    let mut pending: Option<(Option<String>, Option<String>)> = None;
    let mut awaiting_primary_fingerprint = false;

    let flush = |keys: &mut Vec<SigningKey>,
                 pending: &mut Option<(Option<String>, Option<String>)>| {
        let Some((Some(value), label)) = pending.take() else {
            return;
        };
        keys.push(SigningKey {
            label: label.unwrap_or_else(|| value.clone()),
            value,
            format: "openpgp".into(),
        });
    };

    for line in text.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        match fields.first().copied() {
            Some("sec") => {
                flush(&mut keys, &mut pending);
                pending = Some((None, None));
                awaiting_primary_fingerprint = true;
            }
            Some("fpr") if awaiting_primary_fingerprint => {
                if let Some((fingerprint, _)) = pending.as_mut() {
                    *fingerprint = fields
                        .get(9)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                }
                awaiting_primary_fingerprint = false;
            }
            Some("uid") => {
                awaiting_primary_fingerprint = false;
                if let Some((_, label)) = pending.as_mut() {
                    if label.is_none() {
                        *label = fields
                            .get(9)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());
                    }
                }
            }
            Some("ssb") => awaiting_primary_fingerprint = false,
            _ => {}
        }
    }
    flush(&mut keys, &mut pending);
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
        if let Some(label) = ssh_label(content.lines().next().unwrap_or(""), &path) {
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
fn ssh_label(line: &str, path: &Path) -> Option<String> {
    let line = line.trim();
    let mut parts = line.splitn(3, ' ');
    let kind = parts.next().unwrap_or("");
    if !(kind.starts_with("ssh-") || kind.starts_with("sk-") || kind.starts_with("ecdsa-")) {
        return None;
    }
    parts.next()?; // skip the base64 blob
    let comment = parts.next().unwrap_or("").trim();
    let file = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    Some(if comment.is_empty() {
        if file.is_empty() {
            kind.to_string()
        } else {
            format!("{file} · {kind}")
        }
    } else if file.is_empty() {
        format!("{comment} · {kind}")
    } else {
        format!("{comment} · {kind} · {file}")
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
fpr:::::::::9999AAAABBBBCCCCDDDDEEEEFFFF000011112222:
uid:u::::1700000000::HASH2::Grace Hopper <grace@example.com>::::::::::0:
";
        let keys = parse_gpg_secret_keys(sample);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].value, "1111222233334444AAAABBBBCCCCDDDDEEEE0000");
        assert_eq!(keys[0].label, "Ada Lovelace <ada@example.com>");
        assert_eq!(keys[0].format, "openpgp");
        assert_eq!(keys[1].value, "9999AAAABBBBCCCCDDDDEEEEFFFF000011112222");
        assert_eq!(keys[1].label, "Grace Hopper <grace@example.com>");
    }

    #[test]
    fn primary_fingerprints_disambiguate_colliding_long_key_ids() {
        let sample = "\
sec:u:4096:1:DEADBEEFDEADBEEF:1700000000:::u:::scESC:::::::::
fpr:::::::::111111111111111111111111DEADBEEFDEADBEEF:
uid:u::::1700000000::HASH::First Key <first@example.com>::::::::::0:
sec:u:4096:1:DEADBEEFDEADBEEF:1700000000:::u:::scESC:::::::::
fpr:::::::::222222222222222222222222DEADBEEFDEADBEEF:
uid:u::::1700000000::HASH::Second Key <second@example.com>::::::::::0:
";
        let keys = parse_gpg_secret_keys(sample);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].value, "111111111111111111111111DEADBEEFDEADBEEF");
        assert_eq!(keys[1].value, "222222222222222222222222DEADBEEFDEADBEEF");
        assert_ne!(keys[0].value, keys[1].value);
    }

    #[test]
    fn primary_fingerprint_survives_non_key_metadata_records() {
        let sample = "\
sec:u:4096:1:ABCD1234EF567890:1700000000:::u:::scESC:::::::::
grp:::::::::KEYGRIP:
fpr:::::::::1111222233334444AAAABBBBCCCCDDDDEEEE0000:
uid:u::::1700000000::HASH::Ada Lovelace <ada@example.com>::::::::::0:
";
        let keys = parse_gpg_secret_keys(sample);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].value, "1111222233334444AAAABBBBCCCCDDDDEEEE0000");
    }

    #[test]
    fn key_without_a_primary_fingerprint_is_not_offered() {
        let sample = "\
sec:u:4096:1:ABCD1234EF567890:1700000000:::u:::scESC:::::::::
uid:u::::1700000000::HASH::Missing Fingerprint <missing@example.com>::::::::::0:
ssb:u:4096:1:DEADBEEFDEADBEEF:1700000000::::::s:::::::
fpr:::::::::5555666677778888AAAABBBBCCCCDDDDEEEEFFFF:
";
        assert!(parse_gpg_secret_keys(sample).is_empty());
    }

    #[test]
    fn ssh_label_reads_type_and_comment() {
        assert_eq!(
            ssh_label(
                "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 ada@laptop",
                Path::new("/home/ada/.ssh/id_ed25519.pub")
            ),
            Some("ada@laptop · ssh-ed25519 · id_ed25519.pub".into()),
        );
        assert_eq!(
            ssh_label("ssh-rsa AAAAB3Nza", Path::new("/home/ada/.ssh/id_rsa.pub")),
            Some("id_rsa.pub · ssh-rsa".into())
        );
        assert_eq!(
            ssh_label("not a key", Path::new("/home/ada/.ssh/id_rsa.pub")),
            None
        );
        assert_eq!(ssh_label("", Path::new("/home/ada/.ssh/id_rsa.pub")), None);
    }
}
