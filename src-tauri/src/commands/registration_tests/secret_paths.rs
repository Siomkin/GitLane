//! Secret-path audit (`ipc/commands` spec, "Exactly two commands may carry a
//! user-entered secret"): a credential crossing IPC anywhere else would be one
//! more place it could be logged, persisted, or echoed back.

use std::collections::BTreeSet;
use std::fs;

use super::{command_signatures, command_source_files};

/// The only commands allowed to declare a credential parameter. Each hands
/// the secret straight to an OS-backed store — `git credential approve` or the
/// keychain — and never logs, persists, echoes, or returns it.
///
/// Exact in both directions: any other command with a credential parameter
/// fails the test, and so does a listed command that no longer takes one (or
/// no longer exists), so the list cannot go stale.
const SECRET_BEARING_COMMANDS: &[&str] = &["approve_https_credential", "save_provider_token"];

/// A parameter is a credential when any of its snake_case words is one of
/// these: `password`, `token`, `access_token`, `client_secret`, `old_password`
/// all match. The match is word-wise rather than substring so non-secret
/// locators keep passing — today `signing_key` (a key *id*, `set_repo_identity`)
/// and `credential_host` (a hostname, `approve`/`reject_https_credential`) are
/// the intentional non-matches. Name a new secret with one of these words;
/// name a non-secret locator without them.
const SECRET_WORDS: &[&str] = &[
    "password",
    "passwords",
    "token",
    "tokens",
    "secret",
    "secrets",
];

fn is_credential_param(name: &str) -> bool {
    name.split('_').any(|word| {
        SECRET_WORDS
            .iter()
            .any(|secret| secret.eq_ignore_ascii_case(word))
    })
}

#[test]
fn only_secret_bearing_commands_take_a_credential_parameter() {
    let allowed: BTreeSet<&str> = SECRET_BEARING_COMMANDS.iter().copied().collect();
    let mut declared = BTreeSet::new();
    let mut leaks = Vec::new();
    let mut listed_without_secret = Vec::new();
    for file in command_source_files() {
        let source = fs::read_to_string(&file).unwrap();
        for sig in command_signatures(&source) {
            let credentials: Vec<&str> = sig
                .params
                .iter()
                .map(String::as_str)
                .filter(|param| is_credential_param(param))
                .collect();
            let listed = allowed.contains(sig.name.as_str());
            match (credentials.is_empty(), listed) {
                (false, false) => leaks.push(format!(
                    "{}({}) at {}:{}",
                    sig.name,
                    credentials.join(", "),
                    file.display(),
                    sig.line
                )),
                (true, true) => listed_without_secret.push(sig.name.clone()),
                _ => {}
            }
            declared.insert(sig.name);
        }
    }
    let unknown: Vec<_> = allowed
        .iter()
        .filter(|name| !declared.contains(**name))
        .collect();
    assert!(
        unknown.is_empty(),
        "SECRET_BEARING_COMMANDS names commands that are not declared: {unknown:?}"
    );
    assert!(
        listed_without_secret.is_empty(),
        "stale SECRET_BEARING_COMMANDS entries — these commands take no credential \
         parameter: {listed_without_secret:?}"
    );
    assert!(
        leaks.is_empty(),
        "only SECRET_BEARING_COMMANDS may accept a password/token/secret over IPC; \
         hand the secret to git or the keychain from one of them instead: {leaks:?}"
    );
}

#[test]
fn credential_parameter_rule_is_word_wise() {
    for secret in [
        "password",
        "token",
        "access_token",
        "client_secret",
        "old_password",
    ] {
        assert!(
            is_credential_param(secret),
            "{secret} should count as a credential"
        );
    }
    for locator in ["signing_key", "credential_host", "tokenizer", "account_id"] {
        assert!(
            !is_credential_param(locator),
            "{locator} is a non-secret locator and must not trip the audit"
        );
    }
}
