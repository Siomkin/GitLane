//! The probe and install scripts, run under a local `sh` the way a server's
//! login shell would run them.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use super::super::*;
use super::TempDir;

/// Run a remote command string the way the user's login shell would, with
/// `home` as `$HOME`.
fn run_remote(home: &Path, command: &str, stdin: &[u8]) -> std::process::Output {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .env("HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

fn fake_agent() -> Vec<u8> {
    format!("#!/bin/sh\necho gitlane-agent {VERSION}\n").into_bytes()
}

#[test]
fn the_install_script_installs_checks_and_prunes() {
    let home = TempDir::new("home");
    let base = home.0.join(".gitlane-server");
    for (old, stamp) in [("0.0.1", "202001010000"), ("0.0.2", "202101010000")] {
        std::fs::create_dir_all(base.join(old)).unwrap();
        Command::new("touch")
            .args(["-t", stamp])
            .arg(base.join(old))
            .status()
            .unwrap();
    }
    let agent = fake_agent();
    let out = run_remote(&home.0, &remote_sh(&install_script(agent.len())), &agent);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains(&format!("gitlane-agent {VERSION}")));
    assert!(base.join(VERSION).join("gitlane-agent").exists());
    assert!(!base.join(VERSION).join(".gitlane-agent.partial").exists());
    assert!(
        base.join("0.0.2").exists(),
        "the newest previous version is kept"
    );
    assert!(!base.join("0.0.1").exists(), "older versions are pruned");

    let probe = run_remote(&home.0, &probe_script(), b"");
    let found = parse_probe(&String::from_utf8_lossy(&probe.stdout));
    assert!(found.is_current(), "{found:?}");
}

#[test]
fn a_truncated_upload_installs_nothing() {
    let home = TempDir::new("truncated");
    let agent = fake_agent();
    let out = run_remote(
        &home.0,
        &remote_sh(&install_script(agent.len() + 10)),
        &agent,
    );
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains(&format!("{SCRIPT_ERROR}upload truncated"))
    );
    let dir = home.0.join(".gitlane-server").join(VERSION);
    assert!(!dir.join("gitlane-agent").exists());
    assert!(!dir.join(".gitlane-agent.partial").exists());
}

fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn the_install_is_private_under_a_group_writable_umask() {
    let home = TempDir::new("umask");
    let agent = fake_agent();
    let script = format!("umask 002; {}", remote_sh(&install_script(agent.len())));
    let out = run_remote(&home.0, &script, &agent);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let base = home.0.join(".gitlane-server");
    assert_eq!(mode(&base), 0o700);
    assert_eq!(mode(&base.join(VERSION)), 0o700);
    assert_eq!(mode(&base.join(VERSION).join("gitlane-agent")), 0o700);
}

#[test]
fn the_install_tightens_the_directory_and_ignores_a_planted_partial() {
    use std::os::unix::fs::PermissionsExt;
    let home = TempDir::new("planted");
    let dir = home.0.join(".gitlane-server").join(VERSION);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o775)).unwrap();
    let outside = home.0.join("outside");
    std::fs::write(&outside, b"untouched").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join(".gitlane-agent.partial")).unwrap();
    let agent = fake_agent();
    let out = run_remote(&home.0, &remote_sh(&install_script(agent.len())), &agent);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(std::fs::read(dir.join("gitlane-agent")).unwrap(), agent);
    assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
}

#[test]
fn the_probe_tightens_an_old_install_and_works_without_one() {
    use std::os::unix::fs::PermissionsExt;
    let empty = TempDir::new("probe-empty");
    let out = run_remote(&empty.0, &probe_script(), b"");
    let found = parse_probe(&String::from_utf8_lossy(&out.stdout));
    let uname = Command::new("uname").arg("-sm").output().unwrap();
    assert_eq!(
        found.platform,
        String::from_utf8_lossy(&uname.stdout).trim()
    );
    assert_eq!(found.installed, None);

    let home = TempDir::new("probe-old");
    let base = home.0.join(".gitlane-server");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o775)).unwrap();
    run_remote(&home.0, &probe_script(), b"");
    assert_eq!(mode(&base), 0o700);
}

/// `-O` follows links: a link planted where the agent or its directory
/// belongs, pointing at something else the user owns, must not be run or
/// installed through.
#[test]
fn planted_links_are_neither_run_nor_installed_through() {
    use std::os::unix::fs::PermissionsExt;
    let home = TempDir::new("links");
    let base = home.0.join(".gitlane-server");
    let elsewhere = home.0.join("elsewhere");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    let decoy = elsewhere.join("gitlane-agent");
    std::fs::write(&decoy, fake_agent()).unwrap();
    std::fs::set_permissions(&decoy, std::fs::Permissions::from_mode(0o755)).unwrap();
    let dir = base.join(VERSION);

    // The version directory itself is a link to another of the user's folders.
    std::os::unix::fs::symlink(&elsewhere, &dir).unwrap();
    let probe = run_remote(&home.0, &probe_script(), b"");
    let found = parse_probe(&String::from_utf8_lossy(&probe.stdout));
    assert_eq!(found.installed, None, "a linked directory is not run from");

    let agent = b"#!/bin/sh\necho gitlane-agent real\n".to_vec();
    let script = remote_sh(&install_script(agent.len()));
    run_remote(&home.0, &script, &agent);
    assert!(
        !dir.is_symlink(),
        "the link is replaced by a real directory"
    );
    assert_eq!(std::fs::read(&decoy).unwrap(), fake_agent(), "untouched");

    // The agent file is a link to another of the user's executables.
    std::fs::remove_file(dir.join("gitlane-agent")).unwrap();
    std::os::unix::fs::symlink(&decoy, dir.join("gitlane-agent")).unwrap();
    let probe = run_remote(&home.0, &probe_script(), b"");
    let found = parse_probe(&String::from_utf8_lossy(&probe.stdout));
    assert_eq!(found.installed, None, "a linked agent is not run");
}
