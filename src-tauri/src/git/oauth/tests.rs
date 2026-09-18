//! Tests for the sign-in orchestration: the cancel slot, and the device and
//! PKCE flows end-to-end against a mock transport, keychain and clock.

use super::*;

#[test]
fn cancel_sets_the_flag() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState::default()));
    cancel_sign_in(&slot).unwrap();
    assert!(slot.lock().unwrap().canceled);
    assert!(SlotCancel(slot.clone()).is_canceled());
}

#[test]
fn guard_clears_in_progress_and_cancel() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState {
        in_progress: true,
        canceled: true,
        committing: false,
    }));
    {
        let _guard = InProgressGuard(slot.clone());
    }
    let g = slot.lock().unwrap();
    assert!(!g.in_progress);
    assert!(!g.canceled);
}

#[test]
fn claim_honours_a_cancel_that_raced_before_the_slot() {
    // The fast-cancel path: Cancel reaches the slot before the worker claims
    // it. The worker must NOT start (no browser opened, no token stored).
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState::default()));
    cancel_sign_in(&slot).unwrap();

    let err = claim_slot(&slot).unwrap_err();
    assert!(err.contains("canceled"), "{err}");
    let g = slot.lock().unwrap();
    assert!(!g.in_progress, "must not start after a pre-claim cancel");
    assert!(!g.canceled, "the cancel is consumed, not left sticky");
}

#[test]
fn claim_starts_when_not_canceled() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState::default()));
    assert!(claim_slot(&slot).is_ok());
    assert!(slot.lock().unwrap().in_progress);
}

#[test]
fn claim_refuses_a_concurrent_flow() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState {
        in_progress: true,
        canceled: false,
        committing: false,
    }));
    assert!(claim_slot(&slot)
        .unwrap_err()
        .contains("already in progress"));
}

#[test]
fn canceled_flow_cannot_begin_the_credential_commit() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState {
        in_progress: true,
        canceled: true,
        committing: false,
    }));

    assert!(begin_credential_commit(&slot)
        .unwrap_err()
        .contains("canceled"));
    assert!(!slot.lock().unwrap().committing);
}

#[test]
fn credential_commit_linearizes_before_a_late_cancel() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState {
        in_progress: true,
        canceled: false,
        committing: false,
    }));

    begin_credential_commit(&slot).unwrap();
    let error = cancel_sign_in(&slot).unwrap_err();

    let g = slot.lock().unwrap();
    assert!(error.contains("can no longer be canceled"));
    assert!(g.committing);
    assert!(!g.canceled, "cancel is too late once storage has committed");
}

// --- The orchestration end-to-end ---------------------------------------------
//
// `run_sign_in_inner` against a mock transport, an in-memory keychain and an
// instant clock: the step order the UI renders, where the token lands, and the
// cancellation boundary before the keychain write.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::thread::JoinHandle;

use crate::secrets::MemoryStore;

use super::http::testing::MockTransport;

/// The access token every mock token endpoint returns. No progress payload may
/// ever contain it.
const TOKEN: &str = "glpat-SECRET-token-value";

/// A throwaway client-ids dir that cleans itself up on drop.
struct TempData(PathBuf);

impl TempData {
    fn new(tag: &str) -> Self {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "gitlane-oauth-flow-{tag}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempData(dir)
    }
}

impl Drop for TempData {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A virtual clock: `sleep` advances `now()` instead of blocking, so the device
/// poll's interval waits cost nothing. (A no-op `sleep` over a real `now()` would
/// spin until the real interval passed — the poll loop waits for `now()` to move.)
struct InstantClock {
    base: Instant,
    elapsed_ms: std::sync::atomic::AtomicU64,
}

impl InstantClock {
    fn new() -> Self {
        InstantClock {
            base: Instant::now(),
            elapsed_ms: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

impl Clock for InstantClock {
    fn now(&self) -> Instant {
        self.base + Duration::from_millis(self.elapsed_ms.load(std::sync::atomic::Ordering::SeqCst))
    }
    fn sleep(&self, dur: Duration) {
        let millis = u64::try_from(dur.as_millis()).unwrap();
        self.elapsed_ms
            .fetch_add(millis, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Records every progress payload the flow reports, serialized exactly as the
/// command layer sends it to the webview.
#[derive(Default)]
struct Recorder(Mutex<Vec<ProviderOauthProgress>>);

impl Recorder {
    fn record(&self, progress: &ProviderOauthProgress) {
        self.0.lock().unwrap().push(progress.clone());
    }
    fn steps(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.step.clone())
            .collect()
    }
    fn wire_payloads(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|p| serde_json::to_string(p).unwrap())
            .collect()
    }
}

fn new_slot() -> SignInSlot {
    Arc::new(Mutex::new(SignInSlotState::default()))
}

fn stored_token(
    store: &MemoryStore,
    provider: &str,
    host: &str,
    provider_id: &str,
) -> Option<String> {
    let key = SecretKey::new(provider, host, &identity::oauth_account_id(provider_id));
    store.get(&key).unwrap()
}

/// GitLab's device flow: device code, one successful poll, the user lookup.
fn gitlab_device_responses() -> Vec<super::http::HttpResult> {
    vec![
        MockTransport::ok(
            200,
            r#"{"device_code":"dc-1","user_code":"WXYZ-1234","verification_uri":"https://gitlab.example.com/oauth/device","expires_in":600,"interval":5}"#,
        ),
        MockTransport::ok(
            200,
            &format!(r#"{{"access_token":"{TOKEN}","token_type":"Bearer"}}"#),
        ),
        MockTransport::ok(200, r#"{"id":42,"username":"ada","name":"Ada Lovelace"}"#),
    ]
}

const GITLAB_HOST: &str = "gitlab.example.com";

/// A client-ids dir with a GitLab override, so the flow never depends on a
/// compile-time `GITLANE_GITLAB_OAUTH_CLIENT_ID`.
fn gitlab_client_ids(tag: &str) -> TempData {
    let dir = TempData::new(tag);
    client_ids::set(&dir.0, "gitlab", GITLAB_HOST, "client-123").unwrap();
    dir
}

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

/// Answers the PKCE loopback the way a browser redirect would, reading the
/// port and `state` from the authorize URL the flow reports.
fn redirect_to_loopback(authorize_url: &str) -> JoinHandle<()> {
    let param = |name: &str| -> String {
        let start = authorize_url.find(&format!("{name}=")).unwrap() + name.len() + 1;
        let rest = &authorize_url[start..];
        rest[..rest.find('&').unwrap_or(rest.len())].to_string()
    };
    // redirect_uri is `http%3A%2F%2F127.0.0.1%3A<port>%2Fcallback`.
    let redirect_uri = param("redirect_uri");
    let after_host =
        &redirect_uri[redirect_uri.find("127.0.0.1%3A").unwrap() + "127.0.0.1%3A".len()..];
    let port: u16 = after_host[..after_host.find('%').unwrap()].parse().unwrap();
    // `state` is base64url, which percent-encoding leaves unchanged.
    let state = param("state");
    std::thread::spawn(move || {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            stream,
            "GET /callback?code=auth-code-1&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
        )
        .unwrap();
        let mut page = String::new();
        let _ = stream.read_to_string(&mut page);
    })
}

#[test]
fn the_pkce_flow_reports_each_step_in_order_and_stores_the_token() {
    let dir = TempData::new("pkce");
    client_ids::set(&dir.0, "bitbucket", "bitbucket.org", "bb-client").unwrap();
    let recorder = Recorder::default();
    let browser = Mutex::new(None::<JoinHandle<()>>);
    let progress = |p: &ProviderOauthProgress| {
        recorder.record(p);
        if p.step == "browser" {
            let url = p.verification_uri.as_deref().unwrap();
            *browser.lock().unwrap() = Some(redirect_to_loopback(url));
        }
    };
    let http = MockTransport::new(vec![
        MockTransport::ok(
            200,
            &format!(r#"{{"access_token":"{TOKEN}","token_type":"bearer"}}"#),
        ),
        MockTransport::ok(
            200,
            r#"{"uuid":"{abc-123}","username":"grace","display_name":"Grace H."}"#,
        ),
    ]);
    let store = MemoryStore::new();
    let env = SignInEnv {
        progress: &progress,
        client_ids_dir: Some(&dir.0),
        http: &http,
        store: &store,
        clock: &InstantClock::new(),
    };

    let result = run_sign_in_inner(&env, new_slot(), "bitbucket", "bitbucket.org").unwrap();
    if let Some(handle) = browser.lock().unwrap().take() {
        handle.join().unwrap();
    }

    assert_eq!(
        recorder.steps(),
        ["browser", "waiting", "authorized", "storing"]
    );
    assert_eq!(result.login, "grace");
    assert_eq!(result.transport_username, "x-token-auth");
    assert_eq!(
        stored_token(&store, "bitbucket", "bitbucket.org", "{abc-123}").as_deref(),
        Some(TOKEN)
    );
    // The code from the redirect is what was exchanged.
    let requests = http.requests.lock().unwrap();
    assert!(requests[0]
        .form
        .contains(&("code".into(), "auth-code-1".into())));
    for payload in recorder.wire_payloads() {
        assert!(
            !payload.contains(TOKEN),
            "token leaked into progress: {payload}"
        );
    }
}
