//! Shared fixtures for the orchestration tests: a throwaway client-ids dir, a
//! virtual clock, a progress recorder, and canned GitLab device-flow responses.

pub(super) use super::super::http::testing::MockTransport;
pub(super) use super::super::*;
pub(super) use crate::secrets::MemoryStore;
pub(super) use std::path::PathBuf;

/// The access token every mock token endpoint returns. No progress payload may
/// ever contain it.
pub(super) const TOKEN: &str = "glpat-SECRET-token-value";

/// A throwaway client-ids dir that cleans itself up on drop.
pub(super) struct TempData(pub(super) PathBuf);

impl TempData {
    pub(super) fn new(tag: &str) -> Self {
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
pub(super) struct InstantClock {
    base: Instant,
    elapsed_ms: std::sync::atomic::AtomicU64,
}

impl InstantClock {
    pub(super) fn new() -> Self {
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
pub(super) struct Recorder(pub(super) Mutex<Vec<ProviderOauthProgress>>);

impl Recorder {
    pub(super) fn record(&self, progress: &ProviderOauthProgress) {
        self.0.lock().unwrap().push(progress.clone());
    }
    pub(super) fn steps(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.step.clone())
            .collect()
    }
    pub(super) fn wire_payloads(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|p| serde_json::to_string(p).unwrap())
            .collect()
    }
}

pub(super) fn new_slot() -> SignInSlot {
    Arc::new(Mutex::new(SignInSlotState::default()))
}

pub(super) fn stored_token(
    store: &MemoryStore,
    provider: &str,
    host: &str,
    provider_id: &str,
) -> Option<String> {
    let key = SecretKey::new(provider, host, &identity::oauth_account_id(provider_id));
    store.get(&key).unwrap()
}

/// GitLab's device flow: device code, one successful poll, the user lookup.
pub(super) fn gitlab_device_responses() -> Vec<super::super::http::HttpResult> {
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

pub(super) const GITLAB_HOST: &str = "gitlab.example.com";

/// A client-ids dir with a GitLab override, so the flow never depends on a
/// compile-time `GITLANE_GITLAB_OAUTH_CLIENT_ID`.
pub(super) fn gitlab_client_ids(tag: &str) -> TempData {
    let dir = TempData::new(tag);
    client_ids::set(&dir.0, "gitlab", GITLAB_HOST, "client-123").unwrap();
    dir
}
