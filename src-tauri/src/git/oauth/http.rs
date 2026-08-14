//! The single outbound-HTTP seam for the OAuth flows (GL-139).
//!
//! Every network call the OAuth module makes goes through [`HttpTransport`], and
//! the only production implementation ([`UreqTransport`]) is the *only* place in
//! the backend that touches `ureq`. Confining the client here keeps the device /
//! PKCE state machines pure and unit-testable against an in-memory double with no
//! network (see the tests in `device.rs` / `pkce.rs`).
//!
//! A non-2xx HTTP status is **not** a transport error: OAuth token endpoints
//! return `400 { "error": "authorization_pending" }` as part of the normal
//! polling protocol, so [`HttpResponse`] carries the status + body for any
//! completed exchange and `Err` is reserved for a transport/boundary failure
//! (DNS, TLS, connection, timeout, malformed text, or an oversized body).
//!
//! Facade over the focused submodules: `types` (response/error/limits),
//! `transport` (the [`HttpTransport`] trait), `ureq_client` (the production
//! client), and the test-only `testing` double.

mod transport;
mod types;
mod ureq_client;

pub use transport::HttpTransport;
pub use types::{HttpError, HttpResponse, HttpResult, PROVIDER_JSON_RESPONSE_LIMIT};
pub use ureq_client::UreqTransport;

// The default limit is what every transport method falls back to internally;
// only the provider transport tests name it from outside this module.
#[cfg(test)]
pub use types::DEFAULT_RESPONSE_LIMIT;

/// In-memory [`HttpTransport`] for tests: replays a scripted queue of responses
/// and records the requests it saw, so the flow state machines run with no
/// network. Shared here because both `device.rs` and `pkce.rs` exercise it.
#[cfg(test)]
pub mod testing;
