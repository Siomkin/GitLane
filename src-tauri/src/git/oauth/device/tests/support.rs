//! Shared fixtures for the device-flow tests: canned responses, cancel flags,
//! a token-discarding transport, and the virtual clock.

pub(super) use super::super::*;
pub(super) use crate::git::oauth::http::{testing::MockTransport, HttpResult};
pub(super) use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
pub(super) use std::sync::Arc;

pub(super) fn resp(status: u16, body: &str) -> HttpResponse {
    HttpResponse {
        status,
        body: body.to_string(),
    }
}

pub(super) struct NeverCancel;
impl CancelFlag for NeverCancel {
    fn is_canceled(&self) -> bool {
        false
    }
}
pub(super) struct AlwaysCancel;
impl CancelFlag for AlwaysCancel {
    fn is_canceled(&self) -> bool {
        true
    }
}
pub(super) struct CancelAfterFirstWait(pub(super) AtomicU64);
impl CancelFlag for CancelAfterFirstWait {
    fn is_canceled(&self) -> bool {
        self.0.fetch_add(1, Ordering::SeqCst) > 0
    }
}

pub(super) struct SharedCancel(pub(super) Arc<AtomicBool>);
impl CancelFlag for SharedCancel {
    fn is_canceled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

pub(super) struct CancelingTransport {
    pub(super) canceled: Arc<AtomicBool>,
    pub(super) requests: AtomicU64,
}
impl HttpTransport for CancelingTransport {
    fn post_form(
        &self,
        _url: &str,
        _form: &[(&str, &str)],
        _headers: &[(&str, &str)],
    ) -> HttpResult {
        self.requests.fetch_add(1, Ordering::SeqCst);
        self.canceled.store(true, Ordering::SeqCst);
        Ok(resp(200, r#"{"access_token":"must-not-be-accepted"}"#))
    }

    fn get(&self, _url: &str, _headers: &[(&str, &str)]) -> HttpResult {
        unreachable!("device polling never performs GET")
    }
}

/// A clock that never really sleeps: it records every requested sleep and
/// advances a virtual `now` by the requested duration, so deadline logic is
/// deterministic and cancellation slices remain observable.
pub(super) struct TestClock {
    base: Instant,
    elapsed_ms: AtomicU64,
    pub(super) sleeps: std::sync::Mutex<Vec<u64>>,
}
impl TestClock {
    pub(super) fn new() -> Self {
        Self {
            base: Instant::now(),
            elapsed_ms: AtomicU64::new(0),
            sleeps: std::sync::Mutex::new(Vec::new()),
        }
    }
}
impl Clock for TestClock {
    fn now(&self) -> Instant {
        let e = self.elapsed_ms.load(Ordering::SeqCst);
        self.base + Duration::from_millis(e)
    }
    fn sleep(&self, dur: Duration) {
        let millis = u64::try_from(dur.as_millis()).unwrap();
        self.sleeps.lock().unwrap().push(millis);
        self.elapsed_ms.fetch_add(millis, Ordering::SeqCst);
    }
}
