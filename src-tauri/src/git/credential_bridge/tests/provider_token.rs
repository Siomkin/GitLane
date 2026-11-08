//! The provider-token route: what the brokered `GIT_ASKPASS` invocation carries
//! and what the re-entrant helper answers.

use super::*;
use crate::secrets::MemoryStore;

fn bridge() -> ProviderTokenBridge {
    ProviderTokenBridge {
        credential_host: "gitlab.com".into(),
        username: "alice".into(),
        provider: "gitlab".into(),
        account_id: "42".into(),
    }
}

fn stored_token() -> MemoryStore {
    let store = MemoryStore::new();
    store
        .set(
            &SecretKey::new("gitlab", "gitlab.com", "42"),
            "glpat-secret",
        )
        .unwrap();
    store
}

fn askpass_env(invocation: &GitInvocation) -> AskpassEnv {
    let values: std::collections::HashMap<_, _> = invocation.env.iter().cloned().collect();
    AskpassEnv {
        endpoint: values.get(ENV_ENDPOINT).cloned().unwrap_or_default(),
        nonce: values.get(ENV_NONCE).cloned().unwrap_or_default(),
        username: values.get(ENV_USERNAME).cloned().unwrap_or_default(),
    }
}

#[test]
fn answers_username_from_env_and_password_from_parent_broker() {
    let invocation = provider_token_invocation(&bridge(), "/app/GitLane", &stored_token())
        .expect("brokered invocation");
    let env = askpass_env(&invocation);

    assert_eq!(
        answer_askpass("Username for 'https://gitlab.com': ", &env).as_deref(),
        Some("alice")
    );
    assert_eq!(
        answer_askpass("Password for 'https://alice@gitlab.com': ", &env).as_deref(),
        Some("glpat-secret")
    );
}

#[test]
fn missing_token_refuses_to_create_a_broker() {
    let store = MemoryStore::new();
    assert!(provider_token_invocation(&bridge(), "/app/GitLane", &store).is_err());
}

#[test]
fn static_locator_environment_cannot_read_the_keychain() {
    // The former provider/host/account variables are intentionally ignored;
    // without a live endpoint + random nonce, the helper stays silent.
    let env = AskpassEnv {
        endpoint: String::new(),
        nonce: String::new(),
        username: "alice".into(),
    };
    assert_eq!(
        answer_askpass("Password for 'https://alice@gitlab.com': ", &env),
        None
    );
}

#[test]
fn refuses_to_answer_a_password_for_a_different_host() {
    let invocation = provider_token_invocation(&bridge(), "/app/GitLane", &stored_token())
        .expect("brokered invocation");
    let env = askpass_env(&invocation);
    // git is asking for evil.example, our token is scoped to gitlab.com.
    assert_eq!(
        answer_askpass("Password for 'https://alice@evil.example': ", &env),
        None
    );
}

#[test]
fn refuses_a_password_prompt_with_no_parseable_host() {
    // Fail closed: a prompt we cannot attribute to our host must not yield the
    // token (GIT_ASKPASS is inherited by nested git processes).
    let invocation = provider_token_invocation(&bridge(), "/app/GitLane", &stored_token())
        .expect("brokered invocation");
    let env = askpass_env(&invocation);
    assert_eq!(answer_askpass("Password: ", &env), None);
}

#[test]
fn provider_token_invocation_clears_helper_and_carries_no_secret() {
    let inv = provider_token_invocation(
        &bridge(),
        "/Apps/Git Lane.app/Contents/MacOS/GitLane",
        &stored_token(),
    )
    .unwrap();

    // Only the helper-clearing -c line; no gh helper, no secret.
    assert_eq!(
        inv.config,
        vec![
            "-c".to_string(),
            "credential.https://gitlab.com.helper=".to_string(),
        ]
    );
    // Env points GIT_ASKPASS at this binary and carries only a fresh broker
    // capability plus the non-secret username — never keychain locators.
    let env: std::collections::HashMap<_, _> = inv.env.iter().cloned().collect();
    assert_eq!(
        env.get("GIT_ASKPASS").map(String::as_str),
        Some("/Apps/Git Lane.app/Contents/MacOS/GitLane")
    );
    assert_eq!(env.get(ASKPASS_FLAG).map(String::as_str), Some("1"));
    assert!(env.get(ENV_ENDPOINT).is_some_and(|value| !value.is_empty()));
    assert!(env.get(ENV_NONCE).is_some_and(|value| value.len() == 64));
    assert_eq!(env.get(ENV_USERNAME).map(String::as_str), Some("alice"));
    assert!(!env.contains_key("GITLANE_ASKPASS_PROVIDER"));
    assert!(!env.contains_key("GITLANE_ASKPASS_HOST"));
    assert!(!env.contains_key("GITLANE_ASKPASS_ACCOUNT"));
    assert!(inv._broker.is_some());
    // The token itself is never present in the invocation.
    assert!(!inv
        .env
        .iter()
        .any(|(_, v)| v.contains("glpat") || v.contains("secret")));
}
