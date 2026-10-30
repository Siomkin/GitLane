//! Saved SSH connections (remote-ssh-repos D11): a name, host, optional user,
//! port and key file per `ssh://[user@]host[:port]` origin, kept by GitLane in
//! `ssh-connections.json` in the app data directory. No secret is stored: a key
//! file is referred to by its path.

use std::path::{Path, PathBuf};

use super::home_dir;
use super::locator::Locator;
use crate::git::types::SshConnection;

const FILE: &str = "ssh-connections.json";
const MAX_NAME: usize = 80;

/// The origin `connection` connects to, through the same parser as every
/// locator, so `me@HOST` and `me@host` can't become two connections.
pub fn origin_of(connection: &SshConnection) -> Result<String, String> {
    let user = connection
        .user
        .as_deref()
        .filter(|u| !u.is_empty())
        .map(|u| format!("{u}@"))
        .unwrap_or_default();
    let port = connection.port.map(|p| format!(":{p}")).unwrap_or_default();
    Locator::parse(&format!("ssh://{user}{}{port}/", connection.host.trim())).map(|l| l.origin())
}

/// `path` as `ssh -i` should get it: `~/` expanded, and refused when `ssh`
/// could read it as an option, it isn't an absolute path, or there is no file
/// there (`ssh` would only warn and fall back to other keys).
pub fn identity_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.starts_with('-') || path.chars().any(char::is_control) {
        return Err("Enter the path of a private key file.".into());
    }
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => home_dir()
            .ok_or("Couldn't find your home folder to expand ~/.")?
            .join(rest),
        None => PathBuf::from(path),
    };
    if !expanded.is_absolute() {
        return Err("Enter the key file's full path, or one starting with ~/.".into());
    }
    if !expanded.is_file() {
        return Err(format!("There is no key file at {path}."));
    }
    Ok(expanded.to_string_lossy().into_owned())
}

/// Check every field; returns the connection trimmed, with empty optionals
/// cleared.
pub fn validate(connection: &SshConnection) -> Result<SshConnection, String> {
    let name = connection.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(format!(
            "Give the connection a name of 1 to {MAX_NAME} characters."
        ));
    }
    let user = connection
        .user
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let identity_file = connection
        .identity_file
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    if let Some(path) = identity_file {
        identity_path(path)?;
    }
    if connection.port == Some(0) {
        return Err("Enter a port between 1 and 65535.".into());
    }
    let clean = SshConnection {
        name: name.to_string(),
        host: connection.host.trim().to_string(),
        user: user.map(str::to_string),
        port: connection.port,
        identity_file: identity_file.map(str::to_string),
    };
    origin_of(&clean)?;
    Ok(clean)
}

/// The saved connections, sorted by name; an absent or unreadable file is none.
pub fn load(dir: &Path) -> Vec<SshConnection> {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// The saved connection for `origin`, if any.
pub fn for_origin(dir: &Path, origin: &str) -> Option<SshConnection> {
    load(dir)
        .into_iter()
        .find(|c| origin_of(c).is_ok_and(|o| o == origin))
}

/// The `ssh` arguments that make `origin` authenticate with one key file:
/// `form_key` (the connection form's, while testing) or else the saved
/// connection's. None when neither names one. The key is used alone, or agent
/// keys could exhaust the server's attempts before it is tried.
pub fn key_args(dir: &Path, origin: &str, form_key: Option<String>) -> Result<Vec<String>, String> {
    let key = form_key
        .filter(|p| !p.trim().is_empty())
        .or_else(|| for_origin(dir, origin).and_then(|c| c.identity_file));
    Ok(match key {
        Some(path) => vec![
            "-i".into(),
            identity_path(&path)?,
            "-o".into(),
            "IdentitiesOnly=yes".into(),
        ],
        None => Vec::new(),
    })
}

/// Save `connection`, replacing the one for `previous_origin` when editing.
/// Refuses a second connection for an origin that already has one.
pub fn save(
    dir: &Path,
    previous_origin: Option<&str>,
    connection: &SshConnection,
) -> Result<Vec<SshConnection>, String> {
    let connection = validate(connection)?;
    let origin = origin_of(&connection)?;
    let mut all: Vec<SshConnection> = load(dir)
        .into_iter()
        // Editing replaces the edited entry; adding keeps every other one,
        // even one this version can no longer parse.
        .filter(|c| previous_origin.is_none_or(|p| origin_of(c).ok().as_deref() != Some(p)))
        .collect();
    if let Some(existing) = all.iter().find(|c| origin_of(c).is_ok_and(|o| o == origin)) {
        return Err(format!(
            "“{}” already connects to {}.",
            existing.name,
            origin.trim_start_matches("ssh://")
        ));
    }
    all.push(connection);
    write(dir, all)
}

/// Remove the connection for `origin` (a no-op when there is none).
pub fn delete(dir: &Path, origin: &str) -> Result<Vec<SshConnection>, String> {
    let all = load(dir)
        .into_iter()
        .filter(|c| origin_of(c).ok().as_deref() != Some(origin))
        .collect();
    write(dir, all)
}

fn write(dir: &Path, mut all: Vec<SshConnection>) -> Result<Vec<SshConnection>, String> {
    all.sort_by_key(|c| c.name.to_lowercase());
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't save connections: {e}"))?;
    let json = serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?;
    // Write then rename, so a crash never leaves half a file.
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, json)
        .and_then(|()| std::fs::rename(&tmp, dir.join(FILE)))
        .map_err(|e| format!("Couldn't save connections: {e}"))?;
    Ok(all)
}

#[cfg(test)]
mod tests;
