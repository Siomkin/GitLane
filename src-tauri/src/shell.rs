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

use std::path::{Path, PathBuf};
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

/// Keep a spawned console binary (`git`, `gh`, `gpg`, …) from flashing a
/// visible conhost window on Windows: this app is a GUI-subsystem binary, so
/// every console-subsystem child otherwise allocates its own console window —
/// one black flash per spawn, focus-stealing included (GL-81). No-op on other
/// platforms. Call on every `Command` for an external CLI before spawning.
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Whether `name` resolves to an executable in any [`path`] directory — a pure
/// filesystem `which` with no subprocess. On Windows the bare name is expanded
/// through `PATHEXT` (`git-lfs` → `git-lfs.exe`, …), matching how the shell
/// itself resolves commands; a name that already carries an extension is
/// checked as-is.
pub fn command_on_path(name: &str) -> bool {
    command_in_dirs(name, &path())
}

/// The PATH scan behind [`command_on_path`], parameterized on the directory
/// list so tests can probe a controlled dir instead of the process PATH.
fn command_in_dirs(name: &str, dirs: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let candidates = executable_names(name);
    std::env::split_paths(dirs).any(|dir| {
        candidates
            .iter()
            .any(|candidate| executable_exists(&dir.join(candidate)))
    })
}

/// Whether `path` is a file this process could execute. Unix checks the
/// executable bits; Windows has none, so a plain file check is the closest
/// gate (PATHEXT filtering happens in [`executable_names`]).
pub fn executable_exists(path: &Path) -> bool {
    path.is_file() && is_executable(path)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// The candidate filenames `name` may resolve to on this platform: the bare
/// name everywhere, plus `PATHEXT` expansions on Windows (unless the name
/// already has an extension).
fn executable_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        return expand_pathext(name, &pathext);
    }

    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

/// Pure PATHEXT expansion, kept platform-free so unix CI covers the Windows
/// resolution rules (the GL-80 bug — `git-lfs` never matching `git-lfs.exe` —
/// lived exactly here). A name that already carries an extension is returned
/// as-is; a bare name gets each non-empty PATHEXT entry appended.
#[cfg_attr(not(windows), allow(dead_code))]
fn expand_pathext(name: &str, pathext: &str) -> Vec<String> {
    if Path::new(name).extension().is_some() {
        return vec![name.to_string()];
    }
    pathext
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| format!("{name}{ext}"))
        .collect()
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
    cmd.env("PATH", path_var());
    hide_console(&mut cmd);
    cmd.spawn()
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
    fn command_on_path_finds_real_binaries_and_rejects_absent_ones() {
        // `git` is a hard requirement of this app and of the test environment.
        assert!(command_on_path("git"), "git must resolve on PATH");
        assert!(!command_on_path("gitlane-definitely-absent-binary"));
        assert!(!command_on_path(""));
    }

    // The GL-80 regression: a bare `git-lfs` must expand to `git-lfs.exe` (& co)
    // on Windows. The expansion is pure so these run on every platform.
    #[test]
    fn expand_pathext_appends_each_extension_to_a_bare_name() {
        assert_eq!(
            expand_pathext("git-lfs", ".COM;.EXE;.BAT;.CMD"),
            vec!["git-lfs.COM", "git-lfs.EXE", "git-lfs.BAT", "git-lfs.CMD"]
        );
    }

    #[test]
    fn expand_pathext_keeps_a_name_with_extension_as_is() {
        // An explicit extension means the shell would not re-expand it — and the
        // bare name must NOT be a candidate for extensionless lookups (a plain
        // `git-lfs` file is not executable on Windows).
        assert_eq!(expand_pathext("git-lfs.exe", ".COM;.EXE"), vec!["git-lfs.exe"]);
        assert!(!expand_pathext("git-lfs", ".EXE").contains(&"git-lfs".to_string()));
    }

    #[test]
    fn expand_pathext_skips_empty_segments() {
        // A trailing `;` in PATHEXT (common after manual edits) must not create
        // a bare-name candidate.
        assert_eq!(expand_pathext("git-lfs", ";.EXE;"), vec!["git-lfs.EXE"]);
    }

    #[cfg(unix)]
    #[test]
    fn command_in_dirs_respects_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("gitlane-command-in-dirs-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exec = dir.join("git-lfs");
        std::fs::write(&exec, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exec, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("not-exec"), "").unwrap();

        let dirs = dir.to_str().unwrap();
        assert!(command_in_dirs("git-lfs", dirs));
        assert!(!command_in_dirs("not-exec", dirs), "plain file must not match");
        assert!(!command_in_dirs("absent", dirs));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn command_in_dirs_resolves_exe_via_pathext_on_windows() {
        let dir = std::env::temp_dir().join("gitlane-command-in-dirs-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A normal Windows install ships `git-lfs.exe`; the bare name must
        // resolve to it. A bare extensionless file must NOT match.
        std::fs::write(dir.join("git-lfs.exe"), "").unwrap();
        std::fs::write(dir.join("other-tool"), "").unwrap();

        let dirs = dir.to_str().unwrap();
        assert!(command_in_dirs("git-lfs", dirs));
        assert!(!command_in_dirs("other-tool", dirs));

        let _ = std::fs::remove_dir_all(&dir);
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
