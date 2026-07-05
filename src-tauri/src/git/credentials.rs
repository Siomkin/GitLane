//! Git credential-helper integration for HTTPS transport auth.
//!
//! GitLane does not persist secrets. When the user enters a token/password here
//! we hand it to `git credential approve`, so the configured Git credential
//! helper/keychain owns storage. Returned values intentionally report only
//! presence/metadata, never credential output.

use std::io::Write;
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialHelperStatus {
    pub configured: bool,
    pub helpers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSaveResult {
    pub username: String,
    pub helper: String,
}

pub fn helper_status() -> CredentialHelperStatus {
    let helpers = git_config_get_all("credential.helper")
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    CredentialHelperStatus {
        configured: !helpers.is_empty(),
        helpers,
    }
}

pub fn approve_https_credential(
    credential_host: &str,
    path: Option<&str>,
    username: &str,
    password: &str,
) -> Result<CredentialSaveResult, String> {
    validate_credential_field("credential host", credential_host)?;
    if let Some(path) = path {
        validate_credential_field("credential path", path)?;
    }
    validate_credential_field("username", username)?;
    validate_credential_field("password", password)?;

    let username = username.trim();
    if credential_host.trim().is_empty() {
        return Err("Credential host is missing.".into());
    }
    if username.is_empty() {
        return Err("Enter the HTTPS username for this provider.".into());
    }
    if password.is_empty() {
        return Err("Enter the token or password to save in your Git credential helper.".into());
    }

    let status = helper_status();
    if !status.configured {
        return Err(
            "No Git credential helper is configured. Open Settings → Accounts and choose a helper, or configure one in Git.".into(),
        );
    }

    let input = credential_input(credential_host, path, username, Some(password));
    run_git_credential("approve", &input)?;

    let verify = credential_input(credential_host, path, username, None);
    let filled = run_git_credential("fill", &verify)?;
    let has_username = filled.lines().any(|line| {
        line.strip_prefix("username=")
            .is_some_and(|value| value == username)
    });
    let has_password = filled.lines().any(|line| line.starts_with("password="));
    if !has_username || !has_password {
        return Err("Git credential helper did not return the saved credential.".into());
    }

    Ok(CredentialSaveResult {
        username: username.to_string(),
        helper: status.helpers.join(", "),
    })
}

fn validate_credential_field(label: &str, value: &str) -> Result<(), String> {
    if value.chars().any(|c| matches!(c, '\n' | '\r' | '\0')) {
        return Err(format!(
            "Invalid {label}: credential fields cannot contain line breaks or NUL bytes."
        ));
    }
    Ok(())
}

fn credential_input(
    credential_host: &str,
    path: Option<&str>,
    username: &str,
    password: Option<&str>,
) -> String {
    let mut input = format!(
        "protocol=https\nhost={}\nusername={}\n",
        credential_host.trim(),
        username.trim()
    );
    if let Some(path) = path.map(str::trim).filter(|value| !value.is_empty()) {
        input.push_str("path=");
        input.push_str(path.trim_start_matches('/'));
        input.push('\n');
    }
    if let Some(password) = password {
        input.push_str("password=");
        input.push_str(password);
        input.push('\n');
    }
    input.push('\n');
    input
}

fn git_config_get_all(key: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["config", "--get-all", key])
        .env("PATH", crate::shell::path())
        .output()
        .map_err(|e| format!("failed to launch git config: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Ok(String::new())
    }
}

fn run_git_credential(op: &str, input: &str) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(["credential", op])
        .env("PATH", crate::shell::path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::shell::hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch git credential: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("failed to write credential input: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("failed to wait for git credential: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git credential {op} failed")
        } else {
            stderr
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{credential_input, validate_credential_field};

    #[test]
    fn credential_input_preserves_host_path_and_secret() {
        let input = credential_input(
            "dev.azure.com",
            Some("org/project/_git/repo"),
            "alice",
            Some("secret"),
        );
        assert!(input.contains("protocol=https\n"));
        assert!(input.contains("host=dev.azure.com\n"));
        assert!(input.contains("path=org/project/_git/repo\n"));
        assert!(input.contains("username=alice\n"));
        assert!(input.contains("password=secret\n"));
    }

    #[test]
    fn credential_fields_reject_protocol_separators() {
        for value in [
            "github.com\nhost=evil.example",
            "alice\rhost=evil.example",
            "abc\0def",
        ] {
            assert!(validate_credential_field("test", value).is_err());
        }
        assert!(validate_credential_field("test", "github.com:8443").is_ok());
    }
}
