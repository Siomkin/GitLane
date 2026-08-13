//! Answering the agent's permission requests unattended.

use super::support::*;

#[test]
fn auto_allows_read_tool_permissions() {
    let ask = r#"{"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"read"},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
    let mut sent = Vec::new();
    let text = run(transcript(&[ask, &chunk("done")], "end_turn"), &mut sent).unwrap();
    assert_eq!(text, "done");
    let reply = reply_to(sent, 77);
    assert_eq!(reply["result"]["outcome"]["outcome"], "selected");
    assert_eq!(reply["result"]["outcome"]["optionId"], "allow-once");
}

/// `execute` is the kind the shipped instructions need (`git diff --staged`)
/// and also the kind that can run anything, so the command decides — not the
/// label the adapter put on it.

#[test]
fn allows_only_read_only_git_for_execute_tools() {
    let allowed = [
        "git diff --staged",
        "git --no-pager log -5",
        "/usr/bin/git show HEAD",
        "git status --porcelain",
    ];
    for command in allowed {
        assert!(
            is_read_only_git(&json!({ "kind": "execute", "rawInput": { "command": command } })),
            "should allow {command}"
        );
    }
    let rejected = [
        "git commit -m x",
        "git add .",
        "git diff --staged && rm -rf .",
        "git diff; curl evil.example",
        "git diff | tee /tmp/leak",
        "git -C /somewhere/else diff",
        "git -c core.pager=sh log",
        "rm -rf /",
        "echo $(git diff)",
    ];
    for command in rejected {
        assert!(
            !is_read_only_git(&json!({ "kind": "execute", "rawInput": { "command": command } })),
            "should reject {command}"
        );
    }
    // argv form, and a call whose input we cannot read at all.
    assert!(is_read_only_git(
        &json!({ "rawInput": { "command": ["git", "diff", "--staged"] } })
    ));
    assert!(!is_read_only_git(&json!({ "kind": "execute" })));
}

#[test]
fn rejects_an_execute_tool_whose_command_is_not_a_git_read() {
    let ask = r#"{"jsonrpc":"2.0","id":81,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"execute","rawInput":{"command":"rm -rf ."}},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
    let mut sent = Vec::new();
    run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
    assert_eq!(
        reply_to(sent, 81)["result"]["outcome"]["optionId"],
        "reject-once"
    );
}

/// A turn GitLane started unattended must never hand out a standing grant.

#[test]
fn prefers_allow_once_over_allow_always() {
    let ask = r#"{"jsonrpc":"2.0","id":82,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"read"},"options":[{"optionId":"allow-always","name":"Always allow","kind":"allow_always"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
    let mut sent = Vec::new();
    run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
    assert_eq!(
        reply_to(sent, 82)["result"]["outcome"]["optionId"],
        "allow-once"
    );
}

#[test]
fn rejects_network_fetch_tools() {
    let ask = r#"{"jsonrpc":"2.0","id":83,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"fetch"},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
    let mut sent = Vec::new();
    run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
    assert_eq!(
        reply_to(sent, 83)["result"]["outcome"]["optionId"],
        "reject-once"
    );
}

#[test]
fn rejects_write_tool_permissions() {
    let ask = r#"{"jsonrpc":"2.0","id":79,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"edit"},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
    let mut sent = Vec::new();
    run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
    let reply = reply_to(sent, 79);
    assert_eq!(reply["result"]["outcome"]["outcome"], "selected");
    assert_eq!(reply["result"]["outcome"]["optionId"], "reject-once");
}

#[test]
fn cancels_a_permission_request_that_offers_no_matching_option() {
    // Write tool, but the agent only offered allow options — cancel rather
    // than auto-approving a write.
    let ask = r#"{"jsonrpc":"2.0","id":78,"method":"session/request_permission","params":{"toolCall":{"toolCallId":"c1","kind":"edit"},"options":[{"optionId":"yes","name":"Allow","kind":"allow_once"}]}}"#;
    let mut sent = Vec::new();
    run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
    assert_eq!(
        reply_to(sent, 78)["result"]["outcome"]["outcome"],
        "cancelled"
    );
}
