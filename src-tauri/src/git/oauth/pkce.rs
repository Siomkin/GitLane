//! Bitbucket Authorization Code + PKCE flow over a `127.0.0.1` loopback
//! (RFC 8252 / RFC 7636) (GL-139).
//!
//! Bitbucket Cloud has no device flow, so GitLane runs the native-app pattern: a
//! transient loopback listener on `127.0.0.1:<ephemeral>`, a browser sent to the
//! authorize endpoint with an S256 `code_challenge` and a CSRF `state`, and — on
//! the redirect back — an authorization-code exchange bound by the `code_verifier`.
//! No client secret is embedded: PKCE is the proof the token request comes from
//! the same client that started the flow.
//!
//! The verifier, authorization code, and access token are secrets and never leave
//! this process. The loopback listener is dropped the moment the flow ends
//! (success, cancel, or expiry), discarding the codes.
//!
//! Facade over the focused submodules: `codes` (the PKCE pair and CSRF state),
//! `authorize` (the redirect and authorize URLs), `loopback` (the transient
//! listener and its callback parsing), `exchange` (the token request), and
//! `percent` (the query-component encoding both sides share).

mod authorize;
mod codes;
mod exchange;
mod loopback;
mod percent;

pub use authorize::{build_authorize_url, redirect_uri};
pub use codes::{generate_pkce, generate_state};
pub use exchange::exchange_code;
pub use loopback::{bind_loopback, wait_for_redirect};
