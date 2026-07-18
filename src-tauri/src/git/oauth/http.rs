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

use std::fmt;
use std::io::Read;
use std::time::Duration;

/// OAuth and ordinary provider JSON responses are intentionally small. Callers
/// that legitimately return more data must opt into their own bounded limit.
pub const DEFAULT_RESPONSE_LIMIT: usize = 64 * 1024;

/// A transport failure distinct from an HTTP status response. In particular,
/// an oversized body is typed so provider adapters can fail closed instead of
/// parsing a prefix as if it were the complete response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    Transport(String),
    ResponseTooLarge { limit: usize },
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(message) => f.write_str(message),
            Self::ResponseTooLarge { limit } => {
                write!(f, "provider response exceeded the {limit}-byte limit")
            }
        }
    }
}

impl std::error::Error for HttpError {}

impl From<HttpError> for String {
    fn from(error: HttpError) -> Self {
        error.to_string()
    }
}

pub type HttpResult = Result<HttpResponse, HttpError>;

/// A completed HTTP exchange: the status code and the response body. Returned
/// for any response the server actually sent, including 4xx/5xx.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Outbound HTTP for the OAuth flows. Implementors must be `Send + Sync` so the
/// transport can be shared across the blocking sign-in worker.
pub trait HttpTransport: Send + Sync {
    /// POST an `application/x-www-form-urlencoded` body. `headers` are extra
    /// request headers (e.g. `Accept: application/json`).
    fn post_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult;

    /// PUT an `application/x-www-form-urlencoded` body. Used by the GitLab REST
    /// client (GL-140) for `PUT …/merge`; the OAuth flows never call it, so it
    /// carries a default `Method not allowed` impl the mock/ureq clients override.
    fn put_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult {
        let _ = (url, form, headers);
        Err(HttpError::Transport(
            "PUT is not supported by this transport.".to_string(),
        ))
    }

    /// POST an `application/json` body. Used by the Bitbucket REST client (GL-141),
    /// whose create/merge endpoints take nested JSON (`source`/`destination`
    /// branches, `merge_strategy`) that a flat form body cannot express. The OAuth
    /// flows never call it, so a default impl keeps them (and any other transport)
    /// unaffected; the mock/ureq clients override it.
    fn post_json(&self, url: &str, body: &str, headers: &[(&str, &str)]) -> HttpResult {
        let _ = (url, body, headers);
        Err(HttpError::Transport(
            "JSON POST is not supported by this transport.".to_string(),
        ))
    }

    /// GET a resource (used for the post-token identity whoami).
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> HttpResult;

    /// GET with an endpoint-specific body cap. The default implementation keeps
    /// test/custom transports safe; the production transport overrides this so
    /// the limit is enforced while streaming rather than after allocation.
    fn get_with_limit(&self, url: &str, headers: &[(&str, &str)], max_bytes: usize) -> HttpResult {
        let response = self.get(url, headers)?;
        if response.body.len() > max_bytes {
            Err(HttpError::ResponseTooLarge { limit: max_bytes })
        } else {
            Ok(response)
        }
    }
}

/// Production [`HttpTransport`] backed by `ureq` (blocking, rustls). Blocking
/// fits GitLane's `blocking()` subprocess pattern — the whole sign-in runs on the
/// blocking pool — so there is no async runtime to bridge.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl UreqTransport {
    pub fn new() -> Self {
        // A bounded per-request timeout so a hung endpoint can't wedge the
        // sign-in worker; the polling *interval* wait is separate (in device.rs).
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(30))
            .user_agent("GitLane")
            .build();
        Self { agent }
    }
}

impl HttpTransport for UreqTransport {
    fn post_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult {
        let mut req = self.agent.post(url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        to_response(req.send_form(form), DEFAULT_RESPONSE_LIMIT)
    }

    fn put_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult {
        let mut req = self.agent.put(url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        to_response(req.send_form(form), DEFAULT_RESPONSE_LIMIT)
    }

    fn post_json(&self, url: &str, body: &str, headers: &[(&str, &str)]) -> HttpResult {
        let mut req = self.agent.post(url).set("Content-Type", "application/json");
        for (k, v) in headers {
            req = req.set(k, v);
        }
        to_response(req.send_string(body), DEFAULT_RESPONSE_LIMIT)
    }

    fn get(&self, url: &str, headers: &[(&str, &str)]) -> HttpResult {
        self.get_with_limit(url, headers, DEFAULT_RESPONSE_LIMIT)
    }

    fn get_with_limit(&self, url: &str, headers: &[(&str, &str)], max_bytes: usize) -> HttpResult {
        let mut req = self.agent.get(url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        to_response(req.call(), max_bytes)
    }
}

/// Fold a `ureq` result into an [`HttpResponse`]. A `Status` error is a real
/// response (the OAuth protocol uses 4xx for pending/slow-down/denied), so its
/// body is captured; transport and response-boundary failures stay `Err`.
fn to_response(result: Result<ureq::Response, ureq::Error>, max_bytes: usize) -> HttpResult {
    match result {
        Ok(resp) => read_response(resp, max_bytes),
        Err(ureq::Error::Status(_, resp)) => read_response(resp, max_bytes),
        // A transport error may quote the request URL (never a secret — the
        // client id is public and the token rides in a header/body ureq does not
        // echo), but redact defensively at the IPC boundary regardless.
        Err(ureq::Error::Transport(t)) => Err(HttpError::Transport(format!(
            "Network error contacting the provider: {t}"
        ))),
    }
}

fn read_response(resp: ureq::Response, max_bytes: usize) -> HttpResult {
    let status = resp.status();
    let body = read_bounded(resp.into_reader(), max_bytes)?;
    Ok(HttpResponse { status, body })
}

fn read_bounded(mut reader: impl Read, max_bytes: usize) -> Result<String, HttpError> {
    let probe_limit = max_bytes.saturating_add(1);
    let mut bytes = Vec::with_capacity(probe_limit.min(1024 * 1024));
    reader
        .by_ref()
        .take(probe_limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| HttpError::Transport(format!("failed to read provider response: {err}")))?;
    if bytes.len() > max_bytes {
        return Err(HttpError::ResponseTooLarge { limit: max_bytes });
    }
    String::from_utf8(bytes)
        .map_err(|_| HttpError::Transport("provider returned a non-UTF-8 response".to_string()))
}

/// In-memory [`HttpTransport`] for tests: replays a scripted queue of responses
/// and records the requests it saw, so the flow state machines run with no
/// network. Shared here because both `device.rs` and `pkce.rs` exercise it.
#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug, Clone)]
    pub struct RecordedRequest {
        /// HTTP method the caller used: "GET" | "POST" | "PUT". Lets tests assert
        /// the GitLab REST client picks the right verb per operation.
        pub method: String,
        pub url: String,
        pub form: Vec<(String, String)>,
        /// Raw JSON body for a `post_json` call (Bitbucket, GL-141); `None` for
        /// form/GET requests. Lets tests assert the JSON the caller sent.
        pub body: Option<String>,
        /// Request headers the caller set (e.g. `Accept`), so tests can assert
        /// content negotiation — the Bitbucket `/diff` GET must ask for text, not
        /// JSON (GL-141).
        pub headers: Vec<(String, String)>,
        /// Body ceiling selected by the caller. Provider diff endpoints opt
        /// into a larger bounded allowance without widening JSON APIs.
        pub max_bytes: usize,
    }

    #[derive(Default)]
    pub struct MockTransport {
        responses: Mutex<std::collections::VecDeque<HttpResult>>,
        pub requests: Mutex<Vec<RecordedRequest>>,
    }

    impl MockTransport {
        pub fn new(responses: Vec<HttpResult>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }

        pub fn ok(status: u16, body: &str) -> HttpResult {
            Ok(HttpResponse {
                status,
                body: body.to_string(),
            })
        }

        pub fn request_count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }

        fn next(
            &self,
            method: &str,
            url: &str,
            form: &[(&str, &str)],
            body: Option<&str>,
            headers: &[(&str, &str)],
            max_bytes: usize,
        ) -> HttpResult {
            self.requests.lock().unwrap().push(RecordedRequest {
                method: method.to_string(),
                url: url.to_string(),
                form: form
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                body: body.map(str::to_string),
                headers: headers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                max_bytes,
            });
            let response = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| {
                    Err(HttpError::Transport(
                        "mock transport ran out of responses".into(),
                    ))
                })?;
            if response.body.len() > max_bytes {
                Err(HttpError::ResponseTooLarge { limit: max_bytes })
            } else {
                Ok(response)
            }
        }
    }

    impl HttpTransport for MockTransport {
        fn post_form(
            &self,
            url: &str,
            form: &[(&str, &str)],
            headers: &[(&str, &str)],
        ) -> HttpResult {
            self.next("POST", url, form, None, headers, DEFAULT_RESPONSE_LIMIT)
        }

        fn put_form(
            &self,
            url: &str,
            form: &[(&str, &str)],
            headers: &[(&str, &str)],
        ) -> HttpResult {
            self.next("PUT", url, form, None, headers, DEFAULT_RESPONSE_LIMIT)
        }

        fn post_json(&self, url: &str, body: &str, headers: &[(&str, &str)]) -> HttpResult {
            self.next(
                "POST",
                url,
                &[],
                Some(body),
                headers,
                DEFAULT_RESPONSE_LIMIT,
            )
        }

        fn get(&self, url: &str, headers: &[(&str, &str)]) -> HttpResult {
            self.get_with_limit(url, headers, DEFAULT_RESPONSE_LIMIT)
        }

        fn get_with_limit(
            &self,
            url: &str,
            headers: &[(&str, &str)],
            max_bytes: usize,
        ) -> HttpResult {
            self.next("GET", url, &[], None, headers, max_bytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_reader_accepts_the_limit_and_rejects_the_next_byte() {
        assert_eq!(
            read_bounded(Cursor::new(b"1234"), 4).expect("exact limit"),
            "1234"
        );
        assert_eq!(
            read_bounded(Cursor::new(b"12345"), 4),
            Err(HttpError::ResponseTooLarge { limit: 4 })
        );
    }

    #[test]
    fn bounded_reader_rejects_non_utf8_instead_of_returning_an_empty_success() {
        let result = read_bounded(Cursor::new([0xff, 0xfe]), 4);
        assert!(matches!(result, Err(HttpError::Transport(_))));
    }
}
