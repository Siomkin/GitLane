use super::super::probe::{executable_token, probe_available, which};

#[test]
fn probe_available_handles_flags_and_empty() {
    let current_exe = std::env::current_exe().expect("test binary path");
    let command = current_exe.to_string_lossy();
    assert!(probe_available(&command));
    assert!(!probe_available("definitely-not-a-real-binary-xyz"));
    assert!(!probe_available(""), "empty command is unavailable");
    assert!(!probe_available("   "), "whitespace-only is unavailable");
}

#[test]
fn executable_token_skips_env_and_honors_quotes() {
    assert_eq!(executable_token("claude").as_deref(), Some("claude"));
    // Leading env-assignment prefixes are skipped to reach the executable.
    assert_eq!(
        executable_token("FOO=bar claude --model x").as_deref(),
        Some("claude")
    );
    assert_eq!(executable_token("A=1 B=2 ls").as_deref(), Some("ls"));
    // A quoted path with spaces stays a single token (not split on space).
    assert_eq!(
        executable_token("\"/opt/my tools/cli\" -m x").as_deref(),
        Some("/opt/my tools/cli")
    );
    // An absolute path containing `=` is not an env assignment.
    assert_eq!(executable_token("/a=b/cli").as_deref(), Some("/a=b/cli"));
    assert_eq!(executable_token(""), None);
    assert_eq!(executable_token("   "), None);
    assert_eq!(
        executable_token("FOO=bar"),
        None,
        "assignment-only has no executable"
    );
    // Unbalanced quotes are unparseable → treated as unavailable, not guessed.
    assert_eq!(executable_token("\"unterminated"), None);
}

#[test]
fn probing_never_executes_shell_metacharacters() {
    // A command crafted to run a side effect via shell metacharacters must
    // NOT execute it during availability probing — probing is a pure lookup.
    let marker = std::env::temp_dir().join("gitlane_probe_must_not_run");
    let _ = std::fs::remove_file(&marker);
    let payload = format!("x; touch {} #", marker.display());
    let _ = probe_available(&payload);
    // Also hammer `which` directly with a metacharacter-laden name.
    let _ = which(&format!("x; touch {} #", marker.display()));
    let _ = which(&format!("$(touch {})", marker.display()));
    assert!(
        !marker.exists(),
        "availability probing must never execute embedded commands"
    );
    let _ = std::fs::remove_file(&marker);
}
