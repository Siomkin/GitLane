//! Git credential-helper integration for HTTPS transport auth.
//!
//! GitLane does not persist secrets. When the user enters a token/password here
//! we hand it to `git credential approve`, so the configured Git credential
//! helper/keychain owns storage. Returned values intentionally report only
//! presence/metadata, never credential output.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialForgetResult {
    /// The credential helper(s) the erase request was sent to.
    pub helper: String,
}

pub fn helper_status() -> CredentialHelperStatus {
    let mut configured_values = git_config_get_all("credential.helper")
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    configured_values.extend(
        git_config_get_regexp(r"^credential\..*\.helper$")
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                line.split_once(char::is_whitespace)
                    .map(|(_, value)| value.trim())
            })
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned),
    );
    let helpers = sanitized_helper_labels(configured_values.iter().map(String::as_str));
    CredentialHelperStatus {
        configured: !helpers.is_empty(),
        helpers,
    }
}

/// Convert arbitrary `credential.helper` config values into a small, display-safe
/// vocabulary before they cross IPC. A helper value is command syntax, not merely
/// a name: Git accepts executable paths, arguments, and `!` shell snippets, any of
/// which can contain inline credentials. Known helpers retain a useful label;
/// everything else is deliberately opaque.
fn sanitized_helper_labels<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut labels = values
        .into_iter()
        .filter_map(helper_display_label)
        .map(str::to_string)
        .collect::<Vec<_>>();
    labels.sort();
    labels.dedup();
    labels
}

fn helper_display_label(value: &str) -> Option<&'static str> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    let lower = value.to_ascii_lowercase();
    let shell_command = lower.strip_prefix('!').map(str::trim_start);
    if shell_command.is_some_and(|command| command.starts_with("gh auth git-credential")) {
        return Some("GitHub CLI");
    }
    if shell_command.is_some_and(|command| command.starts_with("glab auth git-credential")) {
        return Some("GitLab CLI");
    }
    if shell_command.is_some() {
        return Some("Custom helper");
    }

    // Git appends `git-credential-` to a bare helper name, but also permits an
    // absolute executable path and arguments. Inspect only the first token and
    // only to recognize a fixed allow-list; no part of an unknown value survives.
    let executable = lower.split_whitespace().next().unwrap_or_default();
    let basename = executable.rsplit(['/', '\\']).next().unwrap_or(executable);
    let basename = basename.strip_suffix(".exe").unwrap_or(basename);
    let helper = basename.strip_prefix("git-credential-").unwrap_or(basename);
    Some(match helper {
        "manager" | "manager-core" => "Git Credential Manager",
        "osxkeychain" => "macOS Keychain",
        "libsecret" => "Secret Service",
        "wincred" => "Windows Credential Store",
        "store" => "Plaintext store",
        "cache" => "Memory cache",
        _ => "Custom helper",
    })
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
    if password.is_empty() {
        return Err("Enter the token or password to save in your Git credential helper.".into());
    }

    let status = helper_status();
    if !status.configured {
        return Err(
            "No Git credential helper is configured. Open Settings → Accounts and choose a helper, or configure one in Git.".into(),
        );
    }

    let use_http_path = path.is_some_and(|value| !value.is_empty());
    let input = credential_input(credential_host, path, username, Some(password));
    run_git_credential("approve", &input, use_http_path)?;

    let verify = credential_input(credential_host, path, username, None);
    let filled = run_git_credential("fill", &verify, use_http_path)?;
    let has_username = username.is_empty()
        || filled.lines().any(|line| {
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

/// Forget a saved HTTPS credential via the user's Git credential helper
/// (`git credential reject`). This is the **"forget saved HTTPS credential"**
/// action — deliberately distinct from provider sign-out, which deletes a
/// GitLane-owned keychain token (`provider_tokens::delete_provider_token`). It
/// erases only the helper entry matching this host/path/username and never
/// touches GitLane's own keychain or unrelated credentials. Erasing an absent
/// credential is a success (idempotent).
pub fn reject_https_credential(
    credential_host: &str,
    path: Option<&str>,
    username: &str,
) -> Result<CredentialForgetResult, String> {
    validate_credential_field("credential host", credential_host)?;
    if let Some(path) = path {
        validate_credential_field("credential path", path)?;
    }
    validate_credential_field("username", username)?;

    if credential_host.trim().is_empty() {
        return Err("Credential host is missing.".into());
    }

    let status = helper_status();
    if !status.configured {
        return Err(
            "No Git credential helper is configured, so there is no saved credential to forget."
                .into(),
        );
    }

    // No password: `reject` scopes by protocol/host/[path]/[username] only.
    let use_http_path = path.is_some_and(|value| !value.is_empty());
    let input = credential_input(credential_host, path, username, None);
    run_git_credential("reject", &input, use_http_path)?;

    Ok(CredentialForgetResult {
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
    let mut input = format!("protocol=https\nhost={}\n", credential_host.trim(),);
    if !username.trim().is_empty() {
        input.push_str("username=");
        input.push_str(username.trim());
        input.push('\n');
    }
    // `path` is already the exact context Git derived from the remote URL. Do
    // not trim whitespace or leading slashes: both can result from one-pass URL
    // decoding and are significant when `credential.useHttpPath=true`.
    if let Some(path) = path.filter(|value| !value.is_empty()) {
        input.push_str("path=");
        input.push_str(path);
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
    let (mut command, _scope) = credential_git_command()?;
    let output = command
        .args(["config", "--get-all", key])
        .output()
        .map_err(|e| format!("failed to launch git config: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Ok(String::new())
    }
}

fn git_config_get_regexp(pattern: &str) -> Result<String, String> {
    let (mut command, _scope) = credential_git_command()?;
    let output = command
        .args(["config", "--get-regexp", pattern])
        .output()
        .map_err(|e| format!("failed to launch git config: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Ok(String::new())
    }
}

fn run_git_credential(op: &str, input: &str, use_http_path: bool) -> Result<String, String> {
    let (mut cmd, _scope) = credential_git_command()?;
    if use_http_path {
        cmd.args(["-c", "credential.useHttpPath=true"]);
    }
    cmd.args(["credential", op])
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
            crate::redact::redact_secrets(&stderr)
        })
    }
}

struct CredentialCommandScope(PathBuf);

impl Drop for CredentialCommandScope {
    fn drop(&mut self) {
        // Credential helpers should not write into their process directory. If
        // one does, leave its files intact rather than deleting unknown data.
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn create_credential_command_scope() -> Result<CredentialCommandScope, String> {
    let temp_root = std::env::temp_dir().canonicalize().map_err(|error| {
        format!("Could not resolve the credential helper temporary directory: {error}")
    })?;
    for _ in 0..8 {
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce)
            .map_err(|error| format!("Could not prepare the credential helper scope: {error}"))?;
        let nonce = nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = temp_root.join(format!(
            "gitlane-credential-command-{}-{nonce}",
            std::process::id()
        ));
        // `mode` is the only mutation and it is unix-only, so on other targets
        // the binding is never mutated (`create` takes `&self`).
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        match builder.create(&path) {
            Ok(()) => return Ok(CredentialCommandScope(path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not prepare the credential helper scope: {error}"
                ));
            }
        }
    }
    Err("Could not allocate a unique credential helper scope.".to_string())
}

fn credential_git_command() -> Result<(Command, CredentialCommandScope), String> {
    let scope = create_credential_command_scope()?;
    let ceiling = scope
        .0
        .parent()
        .ok_or_else(|| "Credential helper scope has no parent directory.".to_string())?;
    let mut command = super::isolated_git_command();
    command
        .env("PATH", crate::shell::path())
        .env("GIT_TERMINAL_PROMPT", "0")
        // The fresh directory contains no repository, and the ceiling prevents
        // Git from discovering local config in any temp-directory ancestor.
        .env("GIT_CEILING_DIRECTORIES", ceiling)
        .current_dir(&scope.0);
    crate::shell::hide_console(&mut command);
    Ok((command, scope))
}

#[cfg(test)]
mod tests {
    use super::{
        credential_input, git_config_get_all, run_git_credential, sanitized_helper_labels,
        validate_credential_field, CredentialHelperStatus,
    };
    use crate::git::isolated_git_command;
    use std::process::Command;

    #[test]
    fn helper_metadata_is_sanitized_before_serialization() {
        let secret = "ghp_INLINE_SECRET_SENTINEL";
        let raw = [
            "manager-core",
            "cache --timeout=3600",
            "!gh auth git-credential",
            "!f() { echo username=alice; echo password=ghp_INLINE_SECRET_SENTINEL; }; f",
            "/private/credentials/git-credential-unknown --token ghp_INLINE_SECRET_SENTINEL",
        ];
        let helpers = sanitized_helper_labels(raw);
        assert_eq!(
            helpers,
            [
                "Custom helper",
                "Git Credential Manager",
                "GitHub CLI",
                "Memory cache",
            ]
        );

        let json = serde_json::to_string(&CredentialHelperStatus {
            configured: true,
            helpers,
        })
        .expect("serialize helper status");
        assert!(!json.contains(secret));
        assert!(!json.contains("/private/credentials"));
        assert!(!json.contains("--timeout"));
        assert!(!json.contains("echo password"));
    }

    #[test]
    fn helper_metadata_recognizes_known_executable_paths_without_returning_them() {
        let raw = [
            "/usr/local/bin/git-credential-osxkeychain",
            r"C:\Tools\git-credential-manager-core.exe",
            "store --file=/private/credentials.txt",
            "!glab auth git-credential",
        ];
        assert_eq!(
            sanitized_helper_labels(raw),
            [
                "Git Credential Manager",
                "GitLab CLI",
                "Plaintext store",
                "macOS Keychain",
            ]
        );
    }

    #[test]
    fn credential_input_preserves_exact_git_path_and_secret() {
        let input = credential_input(
            "dev.azure.com",
            Some("org/My Project/_git/repo.git"),
            "alice",
            Some("secret"),
        );
        assert!(input.contains("protocol=https\n"));
        assert!(input.contains("host=dev.azure.com\n"));
        assert!(input.contains("path=org/My Project/_git/repo.git\n"));
        assert!(input.contains("username=alice\n"));
        assert!(input.contains("password=secret\n"));
    }

    #[test]
    fn credential_input_does_not_normalize_path_significant_bytes() {
        let input = credential_input(
            "dev.azure.com",
            Some("/org/project/_git/repo.git "),
            "alice",
            None,
        );
        assert!(input.contains("path=/org/project/_git/repo.git \n"));
    }

    #[test]
    fn credential_input_omits_blank_username() {
        let input = credential_input("gitlab.com", Some("group/repo"), " ", Some("token"));
        assert!(input.contains("protocol=https\n"));
        assert!(input.contains("host=gitlab.com\n"));
        assert!(input.contains("path=group/repo\n"));
        assert!(!input.contains("username="));
        assert!(input.contains("password=token\n"));
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

    #[cfg(unix)]
    #[test]
    fn credential_commands_ignore_inherited_git_config() {
        const CHILD_MARKER: &str = "GITLANE_CREDENTIAL_ENV_TEST_CHILD";
        const POISON_MARKER: &str = "GITLANE_CREDENTIAL_ENV_TEST_MARKER";

        if std::env::var_os(CHILD_MARKER).is_some() {
            let marker = std::env::var(POISON_MARKER).expect("poison marker path");
            let helpers = git_config_get_all("credential.helper").expect("read helper config");
            let input = credential_input(
                "gitlane-routing-env.invalid",
                None,
                "alice",
                Some("never-store-this-test-secret"),
            );
            run_git_credential("approve", &input, false)
                .expect("approve with isolated empty helper config");
            assert!(!helpers.contains("GITLANE_CREDENTIAL_ENV_TEST_MARKER"));
            assert!(
                !std::path::Path::new(&marker).exists(),
                "the inherited credential helper must never execute"
            );
            return;
        }

        let root = std::env::temp_dir().join(format!(
            "gitlane-credential-env-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let marker = root.join("poisoned-helper-ran");
        let poison = format!("!touch \"${}\"", POISON_MARKER);
        let poisoned_repo = root.join("poisoned-cwd");
        std::fs::create_dir(&poisoned_repo).unwrap();
        let poisoned_temp = poisoned_repo.join("tmp");
        std::fs::create_dir(&poisoned_temp).unwrap();
        let init = isolated_git_command()
            .args(["init", "-q"])
            .current_dir(&poisoned_repo)
            .output()
            .expect("initialize poisoned cwd repository");
        assert!(init.status.success());
        let config = isolated_git_command()
            .args(["config", "credential.helper", &poison])
            .current_dir(&poisoned_repo)
            .output()
            .expect("configure poisoned local helper");
        assert!(config.status.success());
        let output = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "git::credentials::tests::credential_commands_ignore_inherited_git_config",
                "--nocapture",
            ])
            .env(CHILD_MARKER, "1")
            .env(POISON_MARKER, &marker)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "credential.helper")
            .env("GIT_CONFIG_VALUE_0", poison)
            .env("TMPDIR", poisoned_temp)
            .current_dir(poisoned_repo)
            .output()
            .expect("launch isolated credential-env regression child");

        assert!(
            output.status.success(),
            "credential-env child failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
