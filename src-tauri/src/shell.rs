//! Helpers for spawning external CLIs (`git`, `gh`, agent binaries).
//!
//! macOS launches GUI apps with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
//! that excludes everything the user's shell profile adds — Homebrew's
//! `/opt/homebrew/bin`, but also `~/.local/bin`, `~/.bun/bin`, `~/.kimi-code/bin`,
//! etc. So binaries like `gh`, `claude`, `codex`, `opencode`, and `kimi` are
//! invisible to the app even though `which <name>` works in a login shell.
//!
//! [`path`] resolves the user's real login-shell PATH once (cached) and falls
//! back to a Homebrew-augmented guess if that fails. Callers do
//! `cmd.env("PATH", crate::shell::path())` before `.output()`/`.spawn()`.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Directories Homebrew installs into. Apple Silicon uses `/opt/homebrew`,
/// Intel Macs `/usr/local`; both are checked so a single binary works everywhere.
/// Listed in priority order — first hit wins. Used only as a fallback when the
/// login-shell PATH can't be resolved.
const HOMEBREW_BINS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// The PATH this app should use when spawning external binaries: the user's
/// login-shell PATH when resolvable (see [`login_path`]), else the current
/// process PATH augmented with Homebrew dirs (see [`augment`]). Result is cached
/// for the process lifetime — profiles don't change at runtime.
pub fn path() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(init).clone()
}

/// Compute the PATH to cache: login-shell PATH if resolvable, else augmented.
fn init() -> String {
    login_path().unwrap_or_else(|| augment(&std::env::var("PATH").unwrap_or_default()))
}

/// Resolve the user's full login-shell PATH by running `$SHELL -lic 'echo $PATH'`.
/// This sources both `.zprofile` and `.zshrc` (the `-l` + `-i` flags), capturing
/// every directory the user's profile adds — the same environment the in-app
/// terminal's own shell gets. Returns `None` if the shell can't run or returns
/// nothing usable.
fn login_path() -> Option<String> {
    #[cfg(windows)]
    {
        return None;
    }

    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let output = Command::new(&shell)
            .args(["-lic", "printf '%s' \"$PATH\""])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&output.stdout);
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

/// Reveal `path` in the OS file manager (macOS Finder, Windows Explorer, or the
/// default Linux handler), selecting the item where the platform supports it.
/// Used by the onboarding "Reveal in Finder" action after a repo is initialized.
/// Spawns and returns immediately — the file manager owns the window.
pub fn reveal(path: &str) -> Result<(), String> {
    let mut cmd = {
        #[cfg(target_os = "macos")]
        {
            let mut c = Command::new("open");
            c.args(["-R", path]);
            c
        }
        #[cfg(target_os = "windows")]
        {
            let mut c = Command::new("explorer");
            // `/select,<path>` highlights the item in its parent folder.
            c.arg(format!("/select,{path}"));
            c
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let mut c = Command::new("xdg-open");
            c.arg(path);
            c
        }
    };
    cmd.env("PATH", path_var())
        .spawn()
        .map_err(|e| format!("failed to reveal {path}: {e}"))?;
    Ok(())
}

/// Internal alias so [`reveal`] can reuse the augmented PATH without colliding
/// with its `path` parameter name.
fn path_var() -> String {
    path()
}

/// Pure fallback: `current` with existing Homebrew `bin` directories prepended
/// (when they exist on disk and aren't already listed). Dirs already present are
/// not duplicated.
fn augment(current: &str) -> String {
    let mut paths: Vec<PathBuf> = std::env::split_paths(current).collect();
    let mut seen: Vec<PathBuf> = paths.clone();

    let mut prefix: Vec<PathBuf> = Vec::new();
    for dir in HOMEBREW_BINS {
        let path = PathBuf::from(dir);
        if path.is_dir() && !seen.contains(&path) {
            prefix.push(path.clone());
            seen.push(path);
        }
    }

    if prefix.is_empty() {
        current.to_string()
    } else {
        prefix.append(&mut paths);
        std::env::join_paths(prefix)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|_| current.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[cfg(not(windows))]
    #[test]
    fn login_path_is_resolvable_on_this_machine() {
        // The dev machine has zsh with a profile; login PATH must resolve and
        // must be richer than the minimal GUI PATH (more than one entry).
        let p = login_path();
        assert!(p.is_some(), "login_path should resolve under a real shell");
        let p = p.unwrap();
        assert!(p.contains(':'), "login PATH should have multiple dirs: {p}");
    }

    #[cfg(not(windows))]
    #[test]
    fn login_path_sees_homebrew() {
        // Sanity: the resolved login PATH includes the Homebrew dir that exists
        // on this machine, proving we're capturing profile additions.
        let existing = HOMEBREW_BINS.iter().find(|d| Path::new(d).is_dir());
        if let Some(dir) = existing {
            let p = login_path().expect("login_path should resolve");
            assert!(
                p.split(':').any(|s| s == *dir),
                "login PATH missing {dir}: {p}"
            );
        }
    }

    #[test]
    fn augment_prepends_existing_homebrew_dir() {
        let existing = HOMEBREW_BINS.iter().find(|d| Path::new(d).is_dir());
        match existing {
            Some(dir) => {
                let current = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
                let out = augment(&current.to_string_lossy());
                let paths: Vec<PathBuf> = std::env::split_paths(&out).collect();
                assert_eq!(
                    paths.first(),
                    Some(&PathBuf::from(dir)),
                    "{dir} should be prepended: {out}"
                );
            }
            None => {
                let current = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
                assert_eq!(
                    augment(&current.to_string_lossy()),
                    current.to_string_lossy()
                );
            }
        }
    }

    #[test]
    fn augment_does_not_duplicate_an_already_present_dir() {
        let dir = "/opt/homebrew/bin";
        let current = std::env::join_paths([dir, "/usr/bin", "/bin"]).unwrap();
        let out = augment(&current.to_string_lossy());
        let count = std::env::split_paths(&out)
            .filter(|s| s == Path::new(dir))
            .count();
        assert_eq!(count, 1, "dir should appear exactly once: {out}");
    }

    #[test]
    fn augment_unchanged_when_no_homebrew_dirs_exist() {
        if HOMEBREW_BINS.iter().any(|d| Path::new(d).is_dir()) {
            return;
        }
        let current = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
        assert_eq!(
            augment(&current.to_string_lossy()),
            current.to_string_lossy()
        );
    }
}
