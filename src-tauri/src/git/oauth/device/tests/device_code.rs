//! The device-code request: defaults, the caps applied to untrusted provider
//! values, and which URI is opened.

use super::support::*;

#[test]
fn parses_device_code_with_defaults() {
    let http = MockTransport::new(vec![MockTransport::ok(
        200,
        r#"{"device_code":"dc","user_code":"WXYZ-1234","verification_uri":"https://gitlab.com/device"}"#,
    )]);
    let dc = request_device_code(
        &http,
        "https://gitlab.com/oauth/authorize_device",
        "cid",
        "read_repository",
    )
    .unwrap();
    assert_eq!(dc.user_code, "WXYZ-1234");
    assert_eq!(dc.interval, 5); // defaulted
    assert_eq!(dc.open_uri(), "https://gitlab.com/device");
}

#[test]
fn bounds_untrusted_device_lifetime() {
    let http = MockTransport::new(vec![MockTransport::ok(
        200,
        &format!(
            r#"{{"device_code":"dc","user_code":"CODE","verification_uri":"https://gitlab.com/device","expires_in":{},"interval":{}}}"#,
            u64::MAX,
            MAX_POLL_INTERVAL_SECS
        ),
    )]);
    let dc = request_device_code(
        &http,
        "https://gitlab.com/oauth/authorize_device",
        "cid",
        "read_repository",
    )
    .unwrap();

    assert_eq!(dc.expires_in, MAX_DEVICE_LIFETIME_SECS);
    assert_eq!(dc.interval, MAX_POLL_INTERVAL_SECS);
}

#[test]
fn rejects_an_untrusted_poll_interval_above_the_cap() {
    let http = MockTransport::new(vec![MockTransport::ok(
        200,
        &format!(
            r#"{{"device_code":"dc","user_code":"CODE","verification_uri":"https://gitlab.com/device","interval":{}}}"#,
            u64::MAX
        ),
    )]);

    let err = request_device_code(
        &http,
        "https://gitlab.com/oauth/authorize_device",
        "cid",
        "read_repository",
    )
    .unwrap_err();

    assert!(err.contains("unsupported device polling interval"));
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
    assert_eq!(
        dc.open_uri(),
        "https://gitlab.com/device?user_code=AAAA-1111"
    );
}
