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

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::http::{HttpResponse, HttpTransport};
use super::CancelFlag;

const B64URL: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// A PKCE verifier/challenge pair (RFC 7636). The verifier is secret; the
/// challenge is safe to put in the authorize URL.
#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// Generate a fresh PKCE pair: a 43+ char base64url verifier from 64 random
/// bytes, and its S256 challenge.
pub fn generate_pkce() -> Result<Pkce, String> {
    let verifier = B64URL.encode(random_bytes::<64>()?);
    let challenge = code_challenge(&verifier);
    Ok(Pkce { verifier, challenge })
}

/// A fresh CSRF `state` value (base64url of 32 random bytes).
pub fn generate_state() -> Result<String, String> {
    Ok(B64URL.encode(random_bytes::<32>()?))
}

/// The S256 code challenge for a verifier: `BASE64URL(SHA256(ASCII(verifier)))`.
pub fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    B64URL.encode(digest)
}

/// The loopback redirect URI for a bound port.
pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

/// Build the authorize URL the browser is sent to.
pub fn build_authorize_url(
    authorize_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    scopes: &str,
    state: &str,
    challenge: &str,
) -> String {
    format!(
        "{authorize_endpoint}?client_id={}&response_type=code&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256&scope={}",
        percent_encode(client_id),
        percent_encode(redirect_uri),
        percent_encode(state),
        percent_encode(challenge),
        percent_encode(scopes),
    )
}

/// The parsed loopback redirect query.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Redirect {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// Bind a loopback listener on an ephemeral port. Returned so the orchestrator
/// can read the port for the redirect URI before opening the browser.
pub fn bind_loopback() -> Result<TcpListener, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Could not start the local sign-in listener: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not configure the local sign-in listener: {e}"))?;
    Ok(listener)
}

/// Wait for the OAuth redirect on the loopback listener, until it arrives, the
/// user cancels, or `deadline` passes. Answers the browser with a small "you can
/// close this window" page. The listener drops when this returns, discarding any
/// in-flight code.
pub fn wait_for_redirect(
    listener: &TcpListener,
    deadline: Instant,
    cancel: &dyn CancelFlag,
) -> Result<Redirect, String> {
    loop {
        if cancel.is_canceled() {
            return Err("Sign-in canceled.".into());
        }
        if Instant::now() >= deadline {
            return Err("The sign-in timed out. Please try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let target = request.lines().next().and_then(parse_callback_target);
                let redirect = target
                    .as_deref()
                    .map(parse_redirect_query)
                    .unwrap_or_default();
                write_browser_response(&mut stream, redirect.error.is_none());
                // Ignore stray probes (favicon, etc.) that carry neither a code
                // nor an error; keep waiting for the real redirect.
                if redirect.code.is_some() || redirect.error.is_some() {
                    return Ok(redirect);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Local sign-in listener failed: {e}")),
        }
    }
}

/// Exchange the authorization code for an access token, bound by the PKCE
/// verifier. Returns the access token (secret).
pub fn exchange_code(
    http: &dyn HttpTransport,
    token_endpoint: &str,
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<String, String> {
    let resp = http.post_form(
        token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ],
        &[("Accept", "application/json")],
    )?;
    if !resp.is_success() {
        return Err(exchange_error(&resp));
    }
    #[derive(Deserialize)]
    struct TokenDto {
        access_token: Option<String>,
    }
    let dto: TokenDto = serde_json::from_str(&resp.body)
        .map_err(|_| "The provider returned an unexpected token response.".to_string())?;
    dto.access_token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "The provider did not return an access token.".to_string())
}

// ---- internals ----

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Could not gather secure randomness for sign-in.".to_string())?;
    Ok(bytes)
}

/// Extract the request target (`/callback?...`) from an HTTP request line
/// (`GET /callback?code=… HTTP/1.1`).
fn parse_callback_target(request_line: &str) -> Option<String> {
    let target = request_line.split_whitespace().nth(1)?;
    target.starts_with('/').then(|| target.to_string())
}

/// Parse the query of a loopback redirect target into its OAuth fields.
fn parse_redirect_query(target: &str) -> Redirect {
    let mut out = Redirect::default();
    let Some((_, query)) = target.split_once('?') else {
        return out;
    };
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some((k, v)) => (k, percent_decode(v)),
            None => (pair, String::new()),
        };
        match key {
            "code" => out.code = Some(value),
            "state" => out.state = Some(value),
            "error" => out.error = Some(value),
            "error_description" => out.error_description = Some(value),
            _ => {}
        }
    }
    out
}

fn write_browser_response(stream: &mut impl Write, ok: bool) {
    let title = if ok { "Signed in" } else { "Sign-in failed" };
    let message = if ok {
        "You're signed in. You can close this tab and return to GitLane."
    } else {
        "Sign-in didn't complete. You can close this tab and try again in GitLane."
    };
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title><body style=\"font-family:system-ui;padding:3rem;text-align:center\"><h2>{title}</h2><p>{message}</p></body>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn exchange_error(resp: &HttpResponse) -> String {
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
            return format!("Could not complete sign-in: {err}.");
        }
    }
    format!("Could not complete sign-in (HTTP {}).", resp.status)
}

/// Percent-encode a query-component value: everything outside the RFC 3986
/// unreserved set is `%XX`.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// Decode a percent-encoded query-component value (`%XX` and `+` → space).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_challenge_matches_rfc7636_vector() {
        // RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generated_pkce_is_valid_and_self_consistent() {
        let pkce = generate_pkce().unwrap();
        assert!((43..=128).contains(&pkce.verifier.len()));
        assert_eq!(code_challenge(&pkce.verifier), pkce.challenge);
        // Two calls differ.
        assert_ne!(generate_pkce().unwrap().verifier, pkce.verifier);
    }

    #[test]
    fn authorize_url_encodes_all_params() {
        let url = build_authorize_url(
            "https://bitbucket.org/site/oauth2/authorize",
            "client id",
            "http://127.0.0.1:5000/callback",
            "account repository:write",
            "st ate",
            "chal+lenge",
        );
        assert!(url.contains("client_id=client%20id"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback"));
        assert!(url.contains("scope=account%20repository%3Awrite"));
        assert!(url.contains("code_challenge=chal%2Blenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("response_type=code"));
    }

    #[test]
    fn parses_the_callback_target_from_a_request_line() {
        assert_eq!(
            parse_callback_target("GET /callback?code=abc&state=xyz HTTP/1.1").as_deref(),
            Some("/callback?code=abc&state=xyz")
        );
        assert_eq!(parse_callback_target("garbage"), None);
    }

    #[test]
    fn parses_success_and_error_redirects() {
        let ok = parse_redirect_query("/callback?code=the%2Bcode&state=st8");
        assert_eq!(ok.code.as_deref(), Some("the+code"));
        assert_eq!(ok.state.as_deref(), Some("st8"));
        assert!(ok.error.is_none());

        let err = parse_redirect_query(
            "/callback?error=access_denied&error_description=User%20said%20no",
        );
        assert_eq!(err.error.as_deref(), Some("access_denied"));
        assert_eq!(err.error_description.as_deref(), Some("User said no"));
        assert!(err.code.is_none());
    }

    #[test]
    fn exchanges_code_for_token() {
        use crate::git::oauth::http::testing::MockTransport;
        let http = MockTransport::new(vec![MockTransport::ok(
            200,
            r#"{"access_token":"bb-secret","token_type":"bearer"}"#,
        )]);
        let token = exchange_code(
            &http,
            "https://bitbucket.org/site/oauth2/access_token",
            "cid",
            "the-code",
            "http://127.0.0.1:5000/callback",
            "verifier",
        )
        .unwrap();
        assert_eq!(token, "bb-secret");
    }

    #[test]
    fn exchange_surfaces_provider_error() {
        use crate::git::oauth::http::testing::MockTransport;
        let http = MockTransport::new(vec![MockTransport::ok(
            400,
            r#"{"error":"invalid_grant","error_description":"code expired"}"#,
        )]);
        let err = exchange_code(
            &http,
            "https://bitbucket.org/site/oauth2/access_token",
            "cid",
            "bad",
            "http://127.0.0.1:5000/callback",
            "verifier",
        )
        .unwrap_err();
        assert_eq!(err, "code expired");
    }

    #[test]
    fn percent_round_trips() {
        for s in ["a b/c:d", "plain", "sym+bol&x=y", "unicøde"] {
            assert_eq!(percent_decode(&percent_encode(s)), s);
        }
    }
}
