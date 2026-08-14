//! Cancellation: before the first request, during an interval wait, and while
//! a request is in flight (its token must be discarded).

use super::support::*;

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
    let clock = TestClock::new();
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
fn cancellation_interrupts_an_interval_wait() {
    let http = MockTransport::new(vec![MockTransport::ok(200, r#"{"access_token":"t"}"#)]);
    let device = DeviceCode {
        device_code: "dc".into(),
        user_code: "AAAA-1111".into(),
        verification_uri: "https://gitlab.com/device".into(),
        verification_uri_complete: None,
        expires_in: 900,
        interval: MAX_POLL_INTERVAL_SECS,
    };
    let clock = TestClock::new();
    let err = poll_for_token(
        &http,
        "https://gitlab.com/oauth/token",
        "cid",
        &device,
        &clock,
        &CancelAfterFirstWait(AtomicU64::new(0)),
    )
    .unwrap_err();

    assert!(err.contains("canceled"));
    assert_eq!(clock.sleeps.lock().unwrap().as_slice(), &[100]);
    assert_eq!(http.request_count(), 0);
}

#[test]
fn cancellation_during_a_request_discards_its_token() {
    let canceled = Arc::new(AtomicBool::new(false));
    let http = CancelingTransport {
        canceled: canceled.clone(),
        requests: AtomicU64::new(0),
    };
    let device = DeviceCode {
        device_code: "dc".into(),
        user_code: "AAAA-1111".into(),
        verification_uri: "https://gitlab.com/device".into(),
        verification_uri_complete: None,
        expires_in: 900,
        interval: 1,
    };
    let err = poll_for_token(
        &http,
        "https://gitlab.com/oauth/token",
        "cid",
        &device,
        &TestClock::new(),
        &SharedCancel(canceled),
    )
    .unwrap_err();

    assert!(err.contains("canceled"));
    assert_eq!(http.requests.load(Ordering::SeqCst), 1);
}
