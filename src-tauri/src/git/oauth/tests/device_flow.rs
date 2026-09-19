//! `run_sign_in_inner` end to end over GitLab's device flow, against a mock
//! transport, an in-memory keychain and a virtual clock: the step order the UI
//! renders, where the token lands, the cancellation boundary before the keychain
//! write, and the failures that must happen before any request.

use super::support::*;

#[test]
fn the_device_flow_reports_each_step_in_order_and_stores_the_token() {
    let dir = gitlab_client_ids("device");
    let recorder = Recorder::default();
    let progress = |p: &ProviderOauthProgress| recorder.record(p);
    let http = MockTransport::new(gitlab_device_responses());
    let store = MemoryStore::new();
    let env = SignInEnv {
        progress: &progress,
        client_ids_dir: Some(&dir.0),
        http: &http,
        store: &store,
        clock: &InstantClock::new(),
    };

    let result = run_sign_in_inner(&env, new_slot(), "gitlab", GITLAB_HOST).unwrap();

    assert_eq!(
        recorder.steps(),
        ["device_code", "polling", "authorized", "storing"]
    );
    let first = &recorder.0.lock().unwrap()[0];
    assert_eq!(first.user_code.as_deref(), Some("WXYZ-1234"));
    assert_eq!(result.login, "ada");
    assert_eq!(result.account_id, identity::oauth_account_id("42"));
    assert_eq!(result.transport_username, "oauth2");
    assert_eq!(
        stored_token(&store, "gitlab", GITLAB_HOST, "42").as_deref(),
        Some(TOKEN)
    );
    // The override, not a built-in, is the client id that reached the provider.
    let requests = http.requests.lock().unwrap();
    assert!(requests[0]
        .form
        .contains(&("client_id".into(), "client-123".into())));
}

#[test]
fn no_progress_payload_ever_carries_the_token() {
    let dir = gitlab_client_ids("no-token");
    let recorder = Recorder::default();
    let progress = |p: &ProviderOauthProgress| recorder.record(p);
    let http = MockTransport::new(gitlab_device_responses());
    let store = MemoryStore::new();
    let env = SignInEnv {
        progress: &progress,
        client_ids_dir: Some(&dir.0),
        http: &http,
        store: &store,
        clock: &InstantClock::new(),
    };

    run_sign_in_inner(&env, new_slot(), "gitlab", GITLAB_HOST).unwrap();

    let payloads = recorder.wire_payloads();
    assert!(!payloads.is_empty());
    for payload in payloads {
        assert!(
            !payload.contains(TOKEN),
            "token leaked into progress: {payload}"
        );
        assert!(
            !payload.contains("dc-1"),
            "device code leaked into progress: {payload}"
        );
    }
}

#[test]
fn a_cancel_before_the_commit_stores_nothing_and_never_reports_storing() {
    // Cancel lands after the provider authorized — while the account is being
    // resolved — and before the keychain write. The commit boundary must refuse.
    let dir = gitlab_client_ids("cancel");
    let slot = new_slot();
    let recorder = Recorder::default();
    let progress = |p: &ProviderOauthProgress| {
        recorder.record(p);
        if p.step == "authorized" {
            cancel_sign_in(&slot).unwrap();
        }
    };
    let http = MockTransport::new(gitlab_device_responses());
    let store = MemoryStore::new();
    let env = SignInEnv {
        progress: &progress,
        client_ids_dir: Some(&dir.0),
        http: &http,
        store: &store,
        clock: &InstantClock::new(),
    };

    let error = run_sign_in_inner(&env, slot.clone(), "gitlab", GITLAB_HOST).unwrap_err();

    assert_eq!(error, "Sign-in canceled.");
    assert_eq!(recorder.steps(), ["device_code", "polling", "authorized"]);
    assert_eq!(stored_token(&store, "gitlab", GITLAB_HOST, "42"), None);
    // The guard leaves the slot clean for the next sign-in.
    let g = slot.lock().unwrap();
    assert!(!g.in_progress && !g.canceled && !g.committing);
}

#[test]
fn an_unsupported_provider_fails_before_any_step_or_request() {
    let recorder = Recorder::default();
    let progress = |p: &ProviderOauthProgress| recorder.record(p);
    let http = MockTransport::new(vec![]);
    let store = MemoryStore::new();
    let env = SignInEnv {
        progress: &progress,
        client_ids_dir: None,
        http: &http,
        store: &store,
        clock: &InstantClock::new(),
    };

    let error = run_sign_in_inner(&env, new_slot(), "github", "github.com").unwrap_err();

    assert!(error.contains("isn't supported"), "{error}");
    assert!(recorder.steps().is_empty());
    assert_eq!(http.request_count(), 0);
}

#[test]
fn a_host_without_any_client_id_fails_before_any_step_or_request() {
    // Only meaningful when this build has no compile-time GitLab client id.
    if config::builtin_client_id("gitlab").is_some() {
        return;
    }
    let dir = TempData::new("no-client");
    let recorder = Recorder::default();
    let progress = |p: &ProviderOauthProgress| recorder.record(p);
    let http = MockTransport::new(vec![]);
    let store = MemoryStore::new();
    let env = SignInEnv {
        progress: &progress,
        client_ids_dir: Some(&dir.0),
        http: &http,
        store: &store,
        clock: &InstantClock::new(),
    };

    let error = run_sign_in_inner(&env, new_slot(), "gitlab", GITLAB_HOST).unwrap_err();

    assert!(error.contains("No OAuth client id"), "{error}");
    assert!(recorder.steps().is_empty());
    assert_eq!(http.request_count(), 0);
}

#[test]
fn an_unresolvable_client_ids_dir_is_not_an_error_for_status() {
    // `None` means the command could not resolve app-data: today's behaviour is
    // to fall back to the built-in id, never to fail the status read.
    let status = client_status(None, "gitlab", "GitLab.Example.com ");

    assert_eq!(status.host, "gitlab.example.com");
    assert!(status.supported);
    let expected = if config::builtin_client_id("gitlab").is_some() {
        "builtin"
    } else {
        "none"
    };
    assert_eq!(status.source, expected);
}
