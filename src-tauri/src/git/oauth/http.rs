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
//! completed exchange and `Err` is reserved for a genuine transport failure
//! (DNS, TLS, connection, timeout).

use std::time::Duration;

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
    fn post_form(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
    ) -> Result<HttpResponse, String>;

    /// PUT an `application/x-www-form-urlencoded` body. Used by the GitLab REST
    /// client (GL-140) for `PUT …/merge`; the OAuth flows never call it, so it
    /// carries a default `Method not allowed` impl the mock/ureq clients override.
    fn put_form(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
    ) -> Result<HttpResponse, String> {
        let _ = (url, form, headers);
        Err("PUT is not supported by this transport.".to_string())
    }

    /// POST an `application/json` body. Used by the Bitbucket REST client (GL-141),
    /// whose create/merge endpoints take nested JSON (`source`/`destination`
    /// branches, `merge_strategy`) that a flat form body cannot express. The OAuth
    /// flows never call it, so a default impl keeps them (and any other transport)
    /// unaffected; the mock/ureq clients override it.
    fn post_json(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> Result<HttpResponse, String> {
        let _ = (url, body, headers);
        Err("JSON POST is not supported by this transport.".to_string())
    }

    /// GET a resource (used for the post-token identity whoami).
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, String>;
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
    fn post_form(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
    ) -> Result<HttpResponse, String> {
        let mut req = self.agent.post(url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        to_response(req.send_form(form))
    }

    fn put_form(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
    ) -> Result<HttpResponse, String> {
        let mut req = self.agent.put(url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        to_response(req.send_form(form))
    }

    fn post_json(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> Result<HttpResponse, String> {
        let mut req = self.agent.post(url).set("Content-Type", "application/json");
        for (k, v) in headers {
            req = req.set(k, v);
        }
        to_response(req.send_string(body))
    }

    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, String> {
        let mut req = self.agent.get(url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        to_response(req.call())
    }
}

/// Fold a `ureq` result into an [`HttpResponse`]. A `Status` error is a real
/// response (the OAuth protocol uses 4xx for pending/slow-down/denied), so its
/// body is captured; only a `Transport` error is surfaced as `Err`.
fn to_response(result: Result<ureq::Response, ureq::Error>) -> Result<HttpResponse, String> {
    match result {
        Ok(resp) => Ok(read_response(resp)),
        Err(ureq::Error::Status(_, resp)) => Ok(read_response(resp)),
        // A transport error may quote the request URL (never a secret — the
        // client id is public and the token rides in a header/body ureq does not
        // echo), but redact defensively at the IPC boundary regardless.
        Err(ureq::Error::Transport(t)) => Err(format!("Network error contacting the provider: {t}")),
    }
}

fn read_response(resp: ureq::Response) -> HttpResponse {
    let status = resp.status();
    // Cap the body so a hostile/huge response can't balloon memory; token and
    // user JSON are tiny.
    let body = resp
        .into_string()
        .unwrap_or_default()
        .chars()
        .take(64 * 1024)
        .collect();
    HttpResponse { status, body }
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
    }

    #[derive(Default)]
    pub struct MockTransport {
        responses: Mutex<std::collections::VecDeque<Result<HttpResponse, String>>>,
        pub requests: Mutex<Vec<RecordedRequest>>,
    }

    impl MockTransport {
        pub fn new(responses: Vec<Result<HttpResponse, String>>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }

        pub fn ok(status: u16, body: &str) -> Result<HttpResponse, String> {
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
        ) -> Result<HttpResponse, String> {
            self.requests.lock().unwrap().push(RecordedRequest {
                method: method.to_string(),
                url: url.to_string(),
                form: form
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                body: body.map(str::to_string),
            });
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("mock transport ran out of responses".into()))
        }
    }

    impl HttpTransport for MockTransport {
        fn post_form(
            &self,
            url: &str,
            form: &[(&str, &str)],
            _headers: &[(&str, &str)],
        ) -> Result<HttpResponse, String> {
            self.next("POST", url, form, None)
        }

        fn put_form(
            &self,
            url: &str,
            form: &[(&str, &str)],
            _headers: &[(&str, &str)],
        ) -> Result<HttpResponse, String> {
            self.next("PUT", url, form, None)
        }

        fn post_json(
            &self,
            url: &str,
            body: &str,
            _headers: &[(&str, &str)],
        ) -> Result<HttpResponse, String> {
            self.next("POST", url, &[], Some(body))
        }

        fn get(&self, url: &str, _headers: &[(&str, &str)]) -> Result<HttpResponse, String> {
            self.next("GET", url, &[], None)
        }
    }
}
