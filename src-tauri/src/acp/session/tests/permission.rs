//! Answering the agent's permission requests unattended.

use super::support::*;
use std::path::Path;

/// A real directory for the gate to resolve paths against.
fn here() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn ro(call: &Value) -> bool {
    is_read_only_git(call, here())
}

#[test]
fn auto_allows_think_tool_permissions() {
    let ask = r#"{"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"think"},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
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
        "git status --porcelain",
        "git diff --output-indicator-new=+",
        "git --no-optional-locks status --porcelain",
        "git log -1 --format=%s -- src",
        // Revisions and in-repo pathspecs are not outside paths.
        "git diff HEAD~1",
        "git diff main..feature -- src/lib.rs",
        "git show HEAD:src/lib.rs",
        // A reflog suffix keeps its braces; quoted globs and parentheses stay literal.
        "git log -1 stash@{0}",
        "git log -1 HEAD@{2.days.ago}",
        "git diff -- '*.rs'",
        "git log --format='(%h) %s' -3",
        "git blame -L 10,20 src/lib.rs",
    ];
    for command in allowed {
        assert!(
            ro(&json!({ "kind": "execute", "rawInput": { "command": command } })),
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
        // Joined-form and unlisted globals redirect where git reads.
        "git --git-dir=/somewhere/else/.git log",
        "git --work-tree=/tmp status",
        "git --config-env=core.pager=SHELL log",
        "git --exec-path=/tmp/bin diff",
        // Options after the subcommand that write a file or leave the repo.
        "git diff --output=.git/config",
        "git log -1 --format=x --output /tmp/out",
        "git diff --no-index /dev/null /etc/hosts",
        "git blame --contents /etc/passwd README.md",
        // git resolves unambiguous abbreviations of long options.
        "git blame --cont=/etc/passwd README.md",
        "git diff --outp /tmp/out",
        // Any `$` expands, zsh `=(` substitutes, a control character splits lines.
        "git show $GITHUB_TOKEN",
        "git rev-parse ${AWS_SECRET_ACCESS_KEY}",
        "git diff =(id)",
        "git log -1\rid",
        "git log -1\0",
        "git log -1\t-p",
        // An external diff program runs only when opted in on log/show.
        "git log -p --ext-diff",
        "git show --ext-diff HEAD",
        // `git diff` turns into `--no-index` by itself for a path outside the
        // work tree, so outside paths are refused in any spelling.
        "git diff /dev/null /etc/passwd",
        "git diff /dev/null ~/.ssh/id_rsa",
        "git diff -- ../other/secret.txt",
        "git log -p -- /etc",
        "git log --format=x --grep=~/notes",
        // The shell would expand these into other arguments than the gate sees.
        "git diff {/dev/null,/etc/shells}",
        "git log -1 --format=format:x --outpu{t,t}=/tmp/out",
        "git log -1 HEAD@{1,2}",
        "git status --short *(e:'touch /tmp/marker':)",
        "git diff .?/out/a .?/out/b",
        "git diff =ls",
        "git diff \\x",
        "git log 'unterminated",
        // Options that read the file they name, outside the repo or in .git.
        "git blame -S/etc/passwd README.md",
        "git blame -pS/etc/passwd README.md",
        "git blame --ignore-revs-file=/etc/passwd README.md",
        "git blame -S.git/config README.md",
        "git blame -S .git/config README.md",
        "git diff -O/etc/passwd",
        // Only a bare `git` runs; a path could be an executable the repo ships.
        "./git diff --staged",
        "/usr/bin/git show HEAD",
    ];
    for command in rejected {
        assert!(
            !ro(&json!({ "kind": "execute", "rawInput": { "command": command } })),
            "should reject {command}"
        );
    }
    // argv form, and a call whose input we cannot read at all.
    assert!(ro(
        &json!({ "rawInput": { "command": ["git", "diff", "--staged"] } })
    ));
    assert!(!ro(&json!({ "kind": "execute" })));
    assert!(!ro(
        &json!({ "rawInput": { "command": ["git", "diff", "/dev/null", "/etc/hosts"] } })
    ));
    assert!(!ro(
        &json!({ "rawInput": { "command": ["git", "blame", "-S/etc/passwd", "README.md"] } })
    ));
    // An absolute path inside the repository is still a pathspec there.
    let inside = format!(
        "git diff --staged -- {}",
        here().join("src/lib.rs").display()
    );
    assert!(
        ro(&json!({ "rawInput": { "command": inside } })),
        "{inside}"
    );
}

/// An argv array is the argv the adapter runs. Joined and re-split, this one
/// is a single quoted `--format` token, while git receives `--output=/tmp/pwn`
/// and overwrites that file.
#[test]
fn rejects_an_argv_array_that_only_passes_when_re_split() {
    let smuggled = json!(["git", "log", "--format='", "--output=/tmp/pwn", "--grep='"]);
    let rejected = [
        json!({ "command": smuggled }),
        json!({ "args": smuggled }),
        // A non-string element is unreadable, not skipped.
        json!({ "command": ["git", 5, "diff"] }),
        json!({ "command": ["git", "diff", ";", "rm"] }),
        // Only one of the two would be read; an adapter may run both.
        json!({ "command": "git log", "args": ["--output=/tmp/pwn"] }),
        json!({ "command": ["git", "log"], "args": ["--output=/tmp/pwn"] }),
    ];
    for input in rejected {
        assert!(
            !ro(&json!({ "kind": "execute", "rawInput": input })),
            "should reject {input}"
        );
    }
    // A shell comment hides the rest from the tokens, not from a shell.
    assert!(!ro(
        &json!({ "rawInput": { "command": "git diff # ; rm -rf ." } })
    ));
}

/// The argv is judged element for element: git receives each element below as
/// one literal argument — a format string, an unknown option (`--out\put`
/// abbreviates nothing), and one `--format` value with a space in it.
/// Re-split, each would be rejected for an argv git never sees.
#[test]
fn judges_argv_elements_as_is() {
    let literal = [
        json!(["git", "log", "--format=%h %s", "-5"]),
        json!(["git", "log", "--format='"]),
        json!(["git", "diff", "--out\\put=x"]),
        json!(["git", "log", "--format=%s --output=/tmp/x"]),
    ];
    let options = json!([
        { "optionId": "reject-once", "kind": "reject_once" },
        { "optionId": "allow-once", "kind": "allow_once" }
    ]);
    for argv in literal {
        for key in ["command", "args"] {
            let call = json!({ "kind": "execute", "rawInput": { key: argv } });
            assert!(ro(&call), "should allow {key}: {argv}");
            let ask = json!({ "toolCall": call, "options": options });
            assert_eq!(
                permission_outcome(Some(&ask), here())["outcome"]["optionId"],
                "allow-once",
                "should allow {key}: {argv} end to end"
            );
        }
    }
}

/// The adapter runs the command in the directory the call names, so a
/// `workdir` (Codex) / `dir_path` (Gemini) other than the session cwd is the
/// same redirect as `--git-dir`.

#[test]
fn execute_must_run_in_the_session_cwd() {
    let options = json!([
        { "optionId": "reject-once", "kind": "reject_once" },
        { "optionId": "allow-once", "kind": "allow_once" }
    ]);
    let ask = |input: serde_json::Value| json!({ "toolCall": { "kind": "execute", "rawInput": input }, "options": options });
    let cwd = here();
    let same = cwd.display().to_string();
    let trailing = format!("{same}/");
    let picked = |input| permission_outcome(Some(&ask(input)), cwd)["outcome"]["optionId"].clone();
    assert_eq!(
        picked(json!({ "command": "git log", "workdir": "/other" })),
        "reject-once"
    );
    assert_eq!(
        picked(json!({ "command": "git log", "dir_path": "sub" })),
        "reject-once"
    );
    assert_eq!(
        picked(json!({ "command": "git log", "cwd": 7 })),
        "reject-once"
    );
    assert_eq!(
        picked(json!({ "command": "git diff --staged", "workdir": same })),
        "allow-once"
    );
    assert_eq!(
        picked(json!({ "command": "git diff --staged", "workdir": trailing })),
        "allow-once"
    );
    assert_eq!(
        picked(json!({ "command": "git diff --staged", "cwd": "" })),
        "allow-once"
    );
    assert_eq!(
        picked(json!({ "command": "git diff --staged" })),
        "allow-once"
    );
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

#[test]
fn rejects_an_execute_tool_that_redirects_git_to_another_repository() {
    let ask = r#"{"jsonrpc":"2.0","id":84,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"execute","rawInput":{"command":"git --git-dir=/other/.git log -p"}},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
    let mut sent = Vec::new();
    run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
    assert_eq!(
        reply_to(sent, 84)["result"]["outcome"]["optionId"],
        "reject-once"
    );
}

/// A turn GitLane started unattended must never hand out a standing grant.

#[test]
fn prefers_allow_once_over_allow_always() {
    let ask = r#"{"jsonrpc":"2.0","id":82,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"think"},"options":[{"optionId":"allow-always","name":"Always allow","kind":"allow_always"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
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
