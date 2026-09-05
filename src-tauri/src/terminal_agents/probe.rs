//! PATH availability probing for a configured agent command line.

use crate::shell;
use std::path::Path;

/// True when the executable of `command` resolves on the user's PATH. Uses the
/// augmented PATH ([`shell::path`]) so Homebrew-installed agents are detected
/// even when the app was launched with the minimal GUI PATH. An empty,
/// whitespace-only, or assignment-only command is treated as unavailable.
pub(super) fn probe_available(command: &str) -> bool {
    match executable_token(command) {
        None => false,
        Some(name) => which(&name),
    }
}

/// Probe a single command's executable on PATH. Exposed for the Settings
/// per-row "Check" action, which validates the command the user is currently
/// typing (possibly unsaved). Thin wrapper over [`probe_available`].
pub fn probe(command: &str) -> bool {
    probe_available(command)
}

/// Extract the executable token from a command line: tokenize honoring shell
/// quoting (so `"/path with spaces/cli"` stays one token), then skip any
/// leading `VAR=value` environment-assignment prefixes (e.g. the `FOO=bar` in
/// `FOO=bar claude`). Returns `None` for an empty / assignment-only command, or
/// one with unbalanced quotes (treated as unavailable rather than guessed).
pub(super) fn executable_token(command: &str) -> Option<String> {
    let tokens = shell_words::split(command).ok()?;
    tokens.into_iter().find(|t| !is_env_assignment(t))
}

/// True for a `NAME=value` shell environment-assignment token, where `NAME` is
/// a valid shell identifier (`[A-Za-z_][A-Za-z0-9_]*`). These precede the
/// executable on a command line and must be skipped when finding it. A leading
/// `=`, a non-identifier name (e.g. an absolute path `"/a=b/cli"`), or no `=`
/// at all are not assignments.
fn is_env_assignment(token: &str) -> bool {
    match token.split_once('=') {
        Some((name, _)) if !name.is_empty() => {
            let mut chars = name.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

/// True when `name` resolves on the user's PATH. This intentionally uses Rust
/// path lookups instead of shelling out to platform-specific lookup commands,
/// so probing works on non-Unix hosts and remains a pure lookup with no side
/// effects from metacharacters in a user-configured command. The PATH scan
/// (with Windows PATHEXT expansion) lives in [`shell::command_on_path`],
/// shared with the git-lfs presence check in `git::status`.
pub(super) fn which(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }

    let path = Path::new(name);
    if path.is_absolute() || name.contains('/') || name.contains('\\') {
        return shell::executable_exists(path);
    }

    shell::command_on_path(name)
}
