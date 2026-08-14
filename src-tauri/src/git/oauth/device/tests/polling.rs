//! The poll loop: the happy path, `slow_down` backoff (and its cap), and
//! expiry.

use super::support::*;

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
    let clock = TestClock::new();
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
    assert!(reqs
        .iter()
        .all(|r| r.url == "https://gitlab.com/oauth/token"));
    let last = reqs.last().unwrap();
    assert!(last
        .form
        .iter()
        .any(|(k, v)| k == "grant_type" && v == "urn:ietf:params:oauth:grant-type:device_code"));
    assert!(last
        .form
        .iter()
        .any(|(k, v)| k == "device_code" && v == "dc"));
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
    let clock = TestClock::new();
    poll_for_token(
        &http,
        "https://gitlab.com/oauth/token",
        "cid",
        &device,
        &clock,
        &NeverCancel,
    )
    .unwrap();
    let sleeps = clock.sleeps.lock().unwrap().clone();
    assert!(sleeps.iter().all(|millis| *millis <= 100));
    assert_eq!(sleeps.iter().sum::<u64>(), 15_000);
}

#[test]
fn slow_down_above_the_interval_cap_fails_closed() {
    let http = MockTransport::new(vec![MockTransport::ok(400, r#"{"error":"slow_down"}"#)]);
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
        &NeverCancel,
    )
    .unwrap_err();

    assert!(err.contains("unsupported device polling interval"));
    assert_eq!(clock.sleeps.lock().unwrap().iter().sum::<u64>(), 60_000);
    assert_eq!(http.request_count(), 1);
}

#[test]
fn expiry_ends_the_loop() {
    // The initial interval reaches the deadline before the first request.
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
    let clock = TestClock::new();
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
