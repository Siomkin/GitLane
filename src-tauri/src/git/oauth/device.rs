//! GitLab OAuth 2.0 Device Authorization Grant (RFC 8628) (GL-139).
//!
//! Two steps: request a device/user code pair, then poll the token endpoint no
//! faster than the server's `interval` until the user authorizes in a browser.
//! The loop honours `slow_down` (add 5s), `authorization_pending`,
//! `expired_token`, `access_denied`, and `device_flow_disabled`, and stops on
//! cancellation or expiry. The device code and the resulting access token are
//! secrets and never leave this process (the token is stored straight into the
//! OS keychain by the orchestrator).
//!
//! The [`HttpTransport`], [`Clock`], and [`CancelFlag`] are all injected so the
//! poll loop unit-tests with no network and no real sleeping.

use std::time::{Duration, Instant};

use serde::Deserialize;

use super::http::{HttpResponse, HttpTransport};
use super::CancelFlag;

/// Injectable clock so the poll loop's interval waits are instant under test.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
    fn sleep(&self, dur: Duration);
}

/// Production clock — real time, real sleeps.
pub struct RealClock;

impl Clock for RealClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn sleep(&self, dur: Duration) {
        std::thread::sleep(dur);
    }
}

/// The device/user code pair the poll loop needs. `device_code` is secret;
/// `user_code` + `verification_uri` are meant to be shown to the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

impl DeviceCode {
    /// The URL to send the user to — the pre-filled `_complete` form when the
    /// provider supplies it, else the plain verification URI.
    pub fn open_uri(&self) -> &str {
        self.verification_uri_complete
            .as_deref()
            .unwrap_or(&self.verification_uri)
    }
}

#[derive(Deserialize)]
struct DeviceCodeDto {
    device_code: String,
    user_code: String,
    #[serde(alias = "verification_url")]
    verification_uri: String,
    #[serde(default, alias = "verification_url_complete")]
    verification_uri_complete: Option<String>,
    #[serde(default = "default_expires")]
    expires_in: u64,
    #[serde(default = "default_interval")]
    interval: u64,
}

fn default_expires() -> u64 {
    900
}
fn default_interval() -> u64 {
    5
}

/// Request a device/user code from GitLab's device-authorization endpoint.
pub fn request_device_code(
    http: &dyn HttpTransport,
    endpoint: &str,
    client_id: &str,
    scopes: &str,
) -> Result<DeviceCode, String> {
    let resp = http.post_form(
        endpoint,
        &[("client_id", client_id), ("scope", scopes)],
        &[("Accept", "application/json")],
    )?;
    if !resp.is_success() {
        return Err(device_request_error(&resp));
    }
    let dto: DeviceCodeDto = serde_json::from_str(&resp.body)
        .map_err(|_| "The provider returned an unexpected device-code response.".to_string())?;
    Ok(DeviceCode {
        device_code: dto.device_code,
        user_code: dto.user_code,
        verification_uri: dto.verification_uri,
        verification_uri_complete: dto.verification_uri_complete.filter(|s| !s.is_empty()),
        expires_in: dto.expires_in.max(1),
        interval: dto.interval.max(1),
    })
}

/// One classified outcome of a single token-poll request.
#[derive(Debug, PartialEq, Eq)]
pub enum PollStep {
    Pending,
    SlowDown,
    /// The access token (secret) — the flow is complete.
    Authorized(String),
    Denied,
    Expired,
    Disabled,
    Failed(String),
}

/// Classify one token-endpoint response. Pure — no I/O, no timing — so every
/// branch is directly unit-testable. Never echoes the raw body (a success body
/// carries the token); it surfaces only known error codes.
pub fn classify_token_response(resp: &HttpResponse) -> PollStep {
    #[derive(Deserialize)]
    struct TokenDto {
        access_token: Option<String>,
        error: Option<String>,
    }
    let dto: TokenDto = match serde_json::from_str(&resp.body) {
        Ok(d) => d,
        Err(_) => {
            return PollStep::Failed("The provider returned an unexpected token response.".into())
        }
    };
    if let Some(token) = dto.access_token.filter(|t| !t.is_empty()) {
        return PollStep::Authorized(token);
    }
    match dto.error.as_deref() {
        Some("authorization_pending") => PollStep::Pending,
        Some("slow_down") => PollStep::SlowDown,
        Some("access_denied") => PollStep::Denied,
        Some("expired_token") => PollStep::Expired,
        Some("device_flow_disabled") => PollStep::Disabled,
        Some(other) => PollStep::Failed(format!("Sign-in failed: {other}.")),
        None => PollStep::Failed("The provider returned an unexpected token response.".into()),
    }
}

/// Poll the token endpoint until the user authorizes, cancels, or the code
/// expires. Returns the access token (secret) on success.
pub fn poll_for_token(
    http: &dyn HttpTransport,
    token_endpoint: &str,
    client_id: &str,
    device: &DeviceCode,
    clock: &dyn Clock,
    cancel: &dyn CancelFlag,
) -> Result<String, String> {
    let mut interval = device.interval.max(1);
    let deadline = clock.now() + Duration::from_secs(device.expires_in);
    loop {
        if cancel.is_canceled() {
            return Err("Sign-in canceled.".into());
        }
        clock.sleep(Duration::from_secs(interval));
        if cancel.is_canceled() {
            return Err("Sign-in canceled.".into());
        }
        if clock.now() >= deadline {
            return Err("The sign-in code expired. Please try again.".into());
        }
        let resp = http.post_form(
            token_endpoint,
            &[
                ("client_id", client_id),
                ("device_code", &device.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
            &[("Accept", "application/json")],
        )?;
        match classify_token_response(&resp) {
            PollStep::Authorized(token) => return Ok(token),
            PollStep::Pending => continue,
            // RFC 8628 §3.5: on slow_down, increase the interval by 5 seconds.
            PollStep::SlowDown => interval += 5,
            PollStep::Denied => return Err("Authorization was denied.".into()),
            PollStep::Expired => {
                return Err("The sign-in code expired. Please try again.".into())
            }
            PollStep::Disabled => {
                return Err("This host has the OAuth device flow disabled.".into())
            }
            PollStep::Failed(msg) => return Err(msg),
        }
    }
}

/// A helpful message for a failed device-code *request* (before polling starts).
fn device_request_error(resp: &HttpResponse) -> String {
    #[derive(Deserialize)]
    struct ErrDto {
        error: Option<String>,
        error_description: Option<String>,
    }
    if let Ok(dto) = serde_json::from_str::<ErrDto>(&resp.body) {
        if let Some(desc) = dto.error_description.filter(|s| !s.is_empty()) {
            return desc;
        }
        if let Some(err) = dto.error.filter(|s| !s.is_empty()) {
            return match err.as_str() {
                "invalid_client" | "unauthorized_client" => {
                    "This host has no registered GitLane OAuth app. Use a personal access token instead."
                        .into()
                }
                other => format!("Could not start sign-in: {other}."),
            };
        }
    }
    format!("Could not start the sign-in (HTTP {}).", resp.status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::oauth::http::testing::MockTransport;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn resp(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            body: body.to_string(),
        }
    }

    struct NeverCancel;
    impl CancelFlag for NeverCancel {
        fn is_canceled(&self) -> bool {
            false
        }
    }
    struct AlwaysCancel;
    impl CancelFlag for AlwaysCancel {
        fn is_canceled(&self) -> bool {
            true
        }
    }

    /// A clock that never really sleeps: it records every requested sleep and
    /// advances a virtual `now` by a fixed step per query, so deadline logic is
    /// deterministic.
    struct TestClock {
        base: Instant,
        elapsed_ms: AtomicU64,
        step_ms: u64,
        sleeps: std::sync::Mutex<Vec<u64>>,
    }
    impl TestClock {
        fn new(step_ms: u64) -> Self {
            Self {
                base: Instant::now(),
                elapsed_ms: AtomicU64::new(0),
                step_ms,
                sleeps: std::sync::Mutex::new(Vec::new()),
            }
        }
    }
    impl Clock for TestClock {
        fn now(&self) -> Instant {
            let e = self.elapsed_ms.fetch_add(self.step_ms, Ordering::SeqCst);
            self.base + Duration::from_millis(e)
        }
        fn sleep(&self, dur: Duration) {
            self.sleeps.lock().unwrap().push(dur.as_secs());
        }
    }

    #[test]
    fn classifies_each_token_outcome() {
        assert_eq!(
            classify_token_response(&resp(200, r#"{"access_token":"glpat-x"}"#)),
            PollStep::Authorized("glpat-x".into())
        );
        assert_eq!(
            classify_token_response(&resp(400, r#"{"error":"authorization_pending"}"#)),
            PollStep::Pending
        );
        assert_eq!(
            classify_token_response(&resp(400, r#"{"error":"slow_down"}"#)),
            PollStep::SlowDown
        );
        assert_eq!(
            classify_token_response(&resp(400, r#"{"error":"access_denied"}"#)),
            PollStep::Denied
        );
        assert_eq!(
            classify_token_response(&resp(400, r#"{"error":"expired_token"}"#)),
            PollStep::Expired
        );
        assert_eq!(
            classify_token_response(&resp(400, r#"{"error":"device_flow_disabled"}"#)),
            PollStep::Disabled
        );
        assert!(matches!(
            classify_token_response(&resp(400, r#"{"error":"invalid_grant"}"#)),
            PollStep::Failed(_)
        ));
        assert!(matches!(
            classify_token_response(&resp(200, "not json")),
            PollStep::Failed(_)
        ));
    }

    #[test]
    fn parses_device_code_with_defaults() {
        let http = MockTransport::new(vec![MockTransport::ok(
            200,
            r#"{"device_code":"dc","user_code":"WXYZ-1234","verification_uri":"https://gitlab.com/device"}"#,
        )]);
        let dc = request_device_code(&http, "https://gitlab.com/oauth/authorize_device", "cid", "read_repository")
            .unwrap();
        assert_eq!(dc.user_code, "WXYZ-1234");
        assert_eq!(dc.interval, 5); // defaulted
        assert_eq!(dc.open_uri(), "https://gitlab.com/device");
    }

    #[test]
    fn prefers_verification_uri_complete_for_opening() {
        let dc = DeviceCode {
            device_code: "dc".into(),
            user_code: "AAAA-1111".into(),
            verification_uri: "https://gitlab.com/device".into(),
            verification_uri_complete: Some("https://gitlab.com/device?user_code=AAAA-1111".into()),
            expires_in: 900,
            interval: 5,
        };
        assert_eq!(dc.open_uri(), "https://gitlab.com/device?user_code=AAAA-1111");
    }

    #[test]
    fn polls_until_authorized() {
        let http = MockTransport::new(vec![
            MockTransport::ok(400, r#"{"error":"authorization_pending"}"#),
            MockTransport::ok(400, r#"{"error":"authorization_pending"}"#),
            MockTransport::ok(200, r#"{"access_token":"glpat-secret"}"#),
        ]);
        let device = DeviceCode {
            device_code: "dc".into(),
            user_code: "AAAA-1111".into(),
            verification_uri: "https://gitlab.com/device".into(),
            verification_uri_complete: None,
            expires_in: 900,
            interval: 5,
        };
        let clock = TestClock::new(10);
        let token = poll_for_token(
            &http,
            "https://gitlab.com/oauth/token",
            "cid",
            &device,
            &clock,
            &NeverCancel,
        )
        .unwrap();
        assert_eq!(token, "glpat-secret");
        assert_eq!(http.request_count(), 3);
        // Every poll hit the token endpoint with the device-code grant + code.
        let reqs = http.requests.lock().unwrap();
        assert!(reqs.iter().all(|r| r.url == "https://gitlab.com/oauth/token"));
        let last = reqs.last().unwrap();
        assert!(last.form.iter().any(|(k, v)| k == "grant_type"
            && v == "urn:ietf:params:oauth:grant-type:device_code"));
        assert!(last.form.iter().any(|(k, v)| k == "device_code" && v == "dc"));
    }

    #[test]
    fn slow_down_increases_the_interval_by_five() {
        let http = MockTransport::new(vec![
            MockTransport::ok(400, r#"{"error":"slow_down"}"#),
            MockTransport::ok(200, r#"{"access_token":"t"}"#),
        ]);
        let device = DeviceCode {
            device_code: "dc".into(),
            user_code: "AAAA-1111".into(),
            verification_uri: "https://gitlab.com/device".into(),
            verification_uri_complete: None,
            expires_in: 900,
            interval: 5,
        };
        let clock = TestClock::new(10);
        poll_for_token(&http, "https://gitlab.com/oauth/token", "cid", &device, &clock, &NeverCancel)
            .unwrap();
        let sleeps = clock.sleeps.lock().unwrap().clone();
        assert_eq!(sleeps, vec![5, 10], "second interval must be first + 5s");
    }

    #[test]
    fn cancellation_stops_before_any_request() {
        let http = MockTransport::new(vec![MockTransport::ok(200, r#"{"access_token":"t"}"#)]);
        let device = DeviceCode {
            device_code: "dc".into(),
            user_code: "AAAA-1111".into(),
            verification_uri: "https://gitlab.com/device".into(),
            verification_uri_complete: None,
            expires_in: 900,
            interval: 5,
        };
        let clock = TestClock::new(10);
        let err = poll_for_token(
            &http,
            "https://gitlab.com/oauth/token",
            "cid",
            &device,
            &clock,
            &AlwaysCancel,
        )
        .unwrap_err();
        assert!(err.contains("canceled"));
        assert_eq!(http.request_count(), 0);
    }

    #[test]
    fn expiry_ends_the_loop() {
        // expires_in is short and the clock advances 100s per query, so the
        // deadline is crossed before the first request.
        let http = MockTransport::new(vec![MockTransport::ok(
            400,
            r#"{"error":"authorization_pending"}"#,
        )]);
        let device = DeviceCode {
            device_code: "dc".into(),
            user_code: "AAAA-1111".into(),
            verification_uri: "https://gitlab.com/device".into(),
            verification_uri_complete: None,
            expires_in: 5,
            interval: 5,
        };
        let clock = TestClock::new(100_000);
        let err = poll_for_token(
            &http,
            "https://gitlab.com/oauth/token",
            "cid",
            &device,
            &clock,
            &NeverCancel,
        )
        .unwrap_err();
        assert!(err.contains("expired"));
        assert_eq!(http.request_count(), 0);
    }

    #[test]
    fn device_request_error_is_actionable_for_bad_client() {
        let msg = device_request_error(&resp(401, r#"{"error":"invalid_client"}"#));
        assert!(msg.contains("no registered GitLane OAuth app"));
    }
}
