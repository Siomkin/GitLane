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

/// Provider values are untrusted. Keep one flow within a 15-minute window and
/// never let an advertised interval make Cancel appear hung for minutes or hours.
const MAX_DEVICE_LIFETIME_SECS: u64 = 15 * 60;
const MAX_POLL_INTERVAL_SECS: u64 = 60;
const CANCEL_CHECK_INTERVAL: Duration = Duration::from_millis(100);

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
        expires_in: bounded_lifetime(dto.expires_in),
        interval: accepted_interval(dto.interval)?,
    })
}

fn bounded_lifetime(seconds: u64) -> u64 {
    seconds.clamp(1, MAX_DEVICE_LIFETIME_SECS)
}

fn accepted_interval(seconds: u64) -> Result<u64, String> {
    let seconds = seconds.max(1);
    if seconds > MAX_POLL_INTERVAL_SECS {
        Err("The provider returned an unsupported device polling interval.".to_string())
    } else {
        Ok(seconds)
    }
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
    // Validate again at the consumer boundary because tests and future internal
    // callers can construct DeviceCode directly without parsing the DTO.
    let mut interval = accepted_interval(device.interval)?;
    let deadline = clock.now() + Duration::from_secs(bounded_lifetime(device.expires_in));
    loop {
        wait_for_next_poll(clock, cancel, deadline, Duration::from_secs(interval))?;
        if cancel.is_canceled() {
            return Err("Sign-in canceled.".into());
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
        // A Cancel may arrive while the network request is in progress. Never
        // accept or persist a token returned after that cancellation.
        if cancel.is_canceled() {
            return Err("Sign-in canceled.".into());
        }
        if clock.now() >= deadline {
            return Err("The sign-in code expired. Please try again.".into());
        }
        match classify_token_response(&resp) {
            PollStep::Authorized(token) => return Ok(token),
            PollStep::Pending => continue,
            // RFC 8628 §3.5: on slow_down, increase the interval by 5 seconds.
            PollStep::SlowDown => {
                interval = interval
                    .checked_add(5)
                    .filter(|next| *next <= MAX_POLL_INTERVAL_SECS)
                    .ok_or_else(|| {
                        "The provider requested an unsupported device polling interval.".to_string()
                    })?
            }
            PollStep::Denied => return Err("Authorization was denied.".into()),
            PollStep::Expired => return Err("The sign-in code expired. Please try again.".into()),
            PollStep::Disabled => {
                return Err("This host has the OAuth device flow disabled.".into())
            }
            PollStep::Failed(msg) => return Err(msg),
        }
    }
}

/// Wait until the next poll without making cancellation wait for the provider's
/// whole interval. The wait never crosses the device-code deadline.
fn wait_for_next_poll(
    clock: &dyn Clock,
    cancel: &dyn CancelFlag,
    deadline: Instant,
    interval: Duration,
) -> Result<(), String> {
    let next_poll = clock
        .now()
        .checked_add(interval)
        .unwrap_or(deadline)
        .min(deadline);
    loop {
        if cancel.is_canceled() {
            return Err("Sign-in canceled.".into());
        }
        let now = clock.now();
        if now >= deadline {
            return Err("The sign-in code expired. Please try again.".into());
        }
        if now >= next_poll {
            return Ok(());
        }
        clock.sleep((next_poll - now).min(CANCEL_CHECK_INTERVAL));
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
mod tests;
