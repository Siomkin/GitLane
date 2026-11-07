/// A Stop that arrives after the answer already landed has no child to
/// kill. It must report "there was nothing running" rather than panic or
/// invent a cancellation.
#[test]
fn cancelling_a_run_that_is_not_running_reports_false() {
    assert!(!cancel("no-such-run-id"));
    assert!(!cancel(""));
}

use super::*;

#[test]
fn stderr_progress_label_surfaces_opencode_stream_errors() {
    assert_eq!(
        stderr_progress_label(
            r#"timestamp=2026-08-12T08:51:03.158Z level=ERROR run=b68917f7 message="stream error" providerID=opencode modelID=big-pickle session.id=ses_1 small=true agent=title"#
        )
        .as_deref(),
        Some("Error · stream error (opencode/big-pickle)")
    );
    // Duplicate skill WARNs must not spam the banner.
    assert_eq!(
        stderr_progress_label(
            r#"timestamp=2026-08-12T08:51:03.158Z level=WARN message="duplicate skill name" name=research"#
        ),
        None
    );
    assert_eq!(stderr_progress_label(""), None);
}

#[test]
fn leading_env_assignments_become_env_not_the_program() {
    let tokens = shell_words::split("FOO=bar _X=a=b claude --acp BAZ=1").unwrap();
    let (env, argv) = split_env_prefix(tokens);
    assert_eq!(
        env,
        vec![
            ("FOO".to_owned(), "bar".to_owned()),
            ("_X".to_owned(), "a=b".to_owned())
        ]
    );
    // Only the prefix is environment; a later `NAME=value` is an argument.
    assert_eq!(argv, vec!["claude", "--acp", "BAZ=1"]);

    let (env, argv) = split_env_prefix(shell_words::split("\"/a=b/cli\" acp").unwrap());
    assert!(env.is_empty());
    assert_eq!(argv, vec!["/a=b/cli", "acp"]);

    // Assignment-only leaves no program, which the launcher reports as empty.
    let (env, argv) = split_env_prefix(vec!["FOO=bar".to_owned()]);
    assert_eq!(env.len(), 1);
    assert!(argv.is_empty());
}

#[test]
fn catalogue_npx_adapters_launch_outside_the_repo() {
    let repo = Path::new("/repo");
    let home = std::env::home_dir().unwrap();
    for command in [
        "npx -y @agentclientprotocol/claude-agent-acp@latest",
        // A row saved before the `@latest` move.
        "npx -y @agentclientprotocol/codex-acp",
    ] {
        assert_eq!(launch_dir(command, repo), home, "{command}");
    }
    // Custom commands may lean on the repo, so they keep it.
    for command in [
        "npx tsx ./scripts/acp-agent.ts",
        "npx my-acp-adapter",
        "cursor-agent acp",
    ] {
        assert_eq!(launch_dir(command, repo), repo, "{command}");
    }
}

fn not_found() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::NotFound, "program not found")
}

#[test]
fn a_missing_package_runner_blames_its_toolchain_not_the_adapter() {
    // `npm i -g <adapter>` is useless advice when npm is the thing missing,
    // and `npx -y` never needed the adapter installed in the first place.
    let message = launch_failure("npx -y @agentclientprotocol/codex-acp", "npx", &not_found());
    assert!(message.contains("Node.js"), "{message}");
    assert!(!message.contains("npm i -g"), "{message}");
    // A resolved launcher path answers the same as the bare name. Each form
    // is asserted where it actually parses as a path: `\` is a separator
    // only on Windows, so the `C:\…` case reads as one long filename
    // everywhere else.
    #[cfg(windows)]
    assert_eq!(
        package_runner_toolchain(r"C:\nodejs\npx.cmd"),
        Some("Node.js")
    );
    #[cfg(not(windows))]
    assert_eq!(
        package_runner_toolchain("/usr/local/bin/npx"),
        Some("Node.js")
    );
    assert_eq!(package_runner_toolchain("cursor-agent"), None);
}

#[test]
fn a_missing_adapter_names_its_own_install_command() {
    // The old message pointed every adapter at the Claude one.
    let message = launch_failure("copilot --acp", "copilot", &not_found());
    assert!(message.contains("npm i -g @github/copilot"), "{message}");
    assert!(
        !message.contains("claude-agent-acp"),
        "the hint must be this adapter's: {message}"
    );

    // A catalogue entry with no install command still says something useful.
    let message = launch_failure("cursor-agent acp", "cursor-agent", &not_found());
    assert!(message.contains("Install the CLI"), "{message}");
}

#[test]
fn a_failure_that_is_not_a_missing_binary_reports_itself() {
    let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
    let message = launch_failure("kimi acp", "kimi", &denied);
    assert!(
        message.starts_with("Could not start the agent `kimi`"),
        "{message}"
    );
}

/// After a Stop reaped the child, the end-of-run reap shares its slot, so
/// it finds the slot empty and signals nothing.
#[cfg(unix)]
#[test]
fn the_end_of_run_reap_after_a_stop_finds_the_slot_empty() {
    use std::os::unix::process::CommandExt;
    let child = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let slot: ChildSlot = Arc::new(Mutex::new(Some(child)));
    assert!(register("stop-then-reap", &slot));
    assert!(cancel("stop-then-reap"));
    assert_eq!(reap(&slot), None);
}

#[cfg(unix)]
fn sleeping_child() -> ChildSlot {
    use std::os::unix::process::CommandExt;
    let child = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    Arc::new(Mutex::new(Some(child)))
}

fn is_recorded(run_id: &str) -> bool {
    runs().contains_key(run_id)
}

#[test]
fn arming_records_the_run_until_its_guard_drops() {
    let guard = arm("arm-then-drop");
    assert!(is_recorded("arm-then-drop"));
    drop(guard);
    assert!(!is_recorded("arm-then-drop"));
    // The probe path passes no id, which is never recorded.
    drop(arm(""));
    assert!(!is_recorded(""));
}

#[test]
fn a_stop_for_a_pending_run_marks_it_stopped() {
    let _guard = arm("pending-stop");
    assert!(!stopped("pending-stop"));
    assert!(cancel("pending-stop"));
    assert!(stopped("pending-stop"));
}

#[cfg(unix)]
#[test]
fn a_stop_for_a_live_run_reaps_it_and_forgets_it() {
    let _guard = arm("live-stop");
    let slot = sleeping_child();
    assert!(register("live-stop", &slot));
    assert!(cancel("live-stop"));
    assert!(slot.lock().unwrap().is_none(), "the child was reaped");
    assert!(!is_recorded("live-stop"));
    assert!(!cancel("live-stop"), "a second Stop finds nothing");
}

#[test]
fn a_stop_before_launch_spawns_nothing() {
    let _guard = arm("stop-before-launch");
    assert!(cancel("stop-before-launch"));
    let mut started = false;
    let result = with_agent(
        "sleep 30",
        Path::new("."),
        "",
        "stop-before-launch",
        None,
        |_, _, _| {
            started = true;
            Ok(())
        },
    );
    assert_eq!(result, Err(STOPPED.to_owned()));
    assert!(!started, "the session never ran");
}

#[cfg(unix)]
#[test]
fn a_stop_while_spawning_leaves_no_live_child() {
    let _guard = arm("stop-while-spawning");
    // The pre-spawn check passed, then the Stop landed before registration.
    assert!(!stopped("stop-while-spawning"));
    let slot = sleeping_child();
    assert!(cancel("stop-while-spawning"));
    assert!(!register("stop-while-spawning", &slot));
    // `with_agent` reaps it on that answer.
    assert!(reap(&slot).is_some());
    assert!(slot.lock().unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn an_unarmed_run_id_still_registers_live() {
    let slot = sleeping_child();
    assert!(register("never-armed", &slot));
    assert!(cancel("never-armed"));
    assert!(slot.lock().unwrap().is_none());
}
