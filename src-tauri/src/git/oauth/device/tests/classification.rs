//! Response classification: every token-endpoint outcome, and the actionable
//! device-request error text.

use super::support::*;

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
fn device_request_error_is_actionable_for_bad_client() {
    let msg = device_request_error(&resp(401, r#"{"error":"invalid_client"}"#));
    assert!(msg.contains("no registered GitLane OAuth app"));
}
