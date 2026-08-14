//! Shared fixtures for the ops tests: the canned-response helper and the
//! repository path every case is built against.

pub(super) use super::super::super::transport::RestClient;
pub(super) use super::super::*;
pub(super) use crate::git::oauth::http::testing::MockTransport;
pub(super) use crate::git::oauth::http::HttpResult;

pub(super) fn ok(body: &str) -> HttpResult {
    MockTransport::ok(200, body)
}

pub(super) const REPO: &str = "repositories/team/app";
