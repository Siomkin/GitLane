//! Remote/local split audit (`ipc/commands` spec, "Every command is declared
//! remote-capable or local-only"): each registered command is either served for
//! an `ssh://` repository (the agent's table in `agent/dispatch.rs`) or listed
//! here as local-only, never both and never neither. The table calls command fns
//! positionally, so this also checks its parameter names against each fn's real
//! signature.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use super::{command_signatures, command_source_files, registered_commands};
use crate::agent::dispatch::{is_remote_capable, REMOTE_SIGNATURES};

/// Commands that never run for a remote repository: they act on this computer
/// (keychain, accounts, terminal, OS openers, app settings), need a forge
/// session, or write files through the file workspace (read-only on remote).
/// Adding a name here is a product decision — the UI disables the feature for
/// remote repositories.
const LOCAL_ONLY: &[&str] = &[
    // Accounts, credentials and provider sign-in.
    "approve_https_credential",
    "cancel_github_sign_in",
    "cancel_provider_oauth_sign_in",
    "delete_provider_token",
    "forge_account",
    "forge_auth_statuses",
    "forge_sign_out",
    "github_accounts",
    "github_sign_in",
    "github_sign_out",
    "oauth_client_status",
    "provider_oauth_sign_in",
    "provider_token_status",
    "refresh_tool_probes",
    "reject_https_credential",
    "save_provider_token",
    "set_oauth_client_id",
    // Binding an account rewrites the remote URL's username; accounts do not
    // apply to remote repositories (`platform/git-invocation`).
    "set_remote_username",
    // Pull requests.
    "approve_pull_request",
    "create_pull_request",
    "link_pull_request_stack",
    "list_pull_requests",
    "merge_pull_request",
    "merge_pull_request_stack",
    "pull_request_checks",
    "pull_request_commits",
    "pull_request_detail",
    "pull_request_diff",
    "pull_request_review_threads",
    "pull_request_reviewer_candidates",
    "pull_request_stack",
    "repository_stacks",
    "resolve_review_thread",
    "set_pull_request_state",
    // This computer: identity defaults, signing keys, OS openers, file writes.
    "default_git_identity",
    "list_signing_keys",
    "open_path_default",
    "open_path_difftool",
    "reveal_in_file_manager",
    "reveal_path",
    "write_repo_file",
    // Creating or listing repositories on this computer.
    "cancel_clone",
    "clone_repo",
    "init_repo",
    "init_repo_in_place",
    "recents_status",
    // Terminal and agent sessions.
    "acp_adapters",
    "acp_agents_get",
    "acp_agents_reset",
    "acp_agents_set",
    "acp_cancel",
    "acp_probe",
    "acp_prompt",
    "commit_agent_messages_get",
    "commit_agent_messages_reset",
    "commit_agent_messages_set",
    "pty_kill",
    "pty_resize",
    "pty_spawn",
    "pty_write",
    "terminal_agent_probe",
    "terminal_agents_get",
    "terminal_agents_reset",
    "terminal_agents_set",
    // App chrome.
    "check_update_on_channel",
    "report_frontend_error",
    // Remote plumbing: these run here and reach the host themselves.
    "list_ssh_hosts",
    "remote_connect",
    "remote_disconnect",
    "answer_ssh_prompt",
    "list_ssh_prompts",
    "test_ssh_connection",
    "remote_invoke",
    "list_ssh_connections",
    "save_ssh_connection",
    "delete_ssh_connection",
];

/// The commands that may carry a user-entered secret (`secret_paths.rs`) must
/// never reach a server.
const SECRET_BEARING: &[&str] = &[
    "answer_ssh_prompt",
    "approve_https_credential",
    "save_provider_token",
];

#[test]
fn every_command_is_remote_capable_or_local_only() {
    let local: BTreeSet<&str> = LOCAL_ONLY.iter().copied().collect();
    assert_eq!(local.len(), LOCAL_ONLY.len(), "duplicate LOCAL_ONLY entry");

    let mut both = Vec::new();
    let mut neither = Vec::new();
    for name in registered_commands() {
        match (is_remote_capable(&name), local.contains(name.as_str())) {
            (true, true) => both.push(name),
            (false, false) => neither.push(name),
            _ => {}
        }
    }
    assert!(both.is_empty(), "remote-capable and LOCAL_ONLY: {both:?}");
    assert!(
        neither.is_empty(),
        "unclassified — add to the agent table or LOCAL_ONLY: {neither:?}"
    );

    let registered: BTreeSet<String> = registered_commands().into_iter().collect();
    let stale: Vec<_> = local
        .iter()
        .filter(|name| !registered.contains(**name))
        .collect();
    assert!(stale.is_empty(), "LOCAL_ONLY names no command: {stale:?}");
}

#[test]
fn secret_bearing_commands_are_local_only() {
    for name in SECRET_BEARING {
        assert!(LOCAL_ONLY.contains(name), "{name} must be LOCAL_ONLY");
        assert!(!is_remote_capable(name), "{name} must not be forwarded");
    }
}

#[test]
fn table_parameters_match_the_command_signatures() {
    let mut declared: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for file in command_source_files() {
        for sig in command_signatures(&fs::read_to_string(file).unwrap()) {
            declared.insert(sig.name, sig.params);
        }
    }
    for (name, params) in REMOTE_SIGNATURES {
        let actual = declared
            .get(*name)
            .unwrap_or_else(|| panic!("table entry {name} is not a declared command"));
        assert_eq!(
            actual, params,
            "{name}: table parameters must match the fn signature, in order"
        );
    }
}
