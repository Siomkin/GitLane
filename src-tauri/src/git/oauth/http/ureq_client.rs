//! The production `ureq`-backed transport and its bounded response reader.

use std::io::Read;
use std::time::Duration;

use super::transport::HttpTransport;
use super::types::{HttpError, HttpResponse, HttpResult, DEFAULT_RESPONSE_LIMIT};

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
        // 4xx/5xx are part of the OAuth protocol (pending / slow-down / denied),
        // so they must arrive as [`HttpResponse`] rather than `ureq::Error`.
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .user_agent("GitLane")
            .http_status_as_error(false)
            .build()
            .into();
        Self { agent }
    }
}

impl HttpTransport for UreqTransport {
    fn post_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult {
        self.post_form_with_limit(url, form, headers, DEFAULT_RESPONSE_LIMIT)
    }

    fn post_form_with_limit(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> HttpResult {
        let mut req = self.agent.post(url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        to_response(req.send_form(form.iter().copied()), max_bytes)
    }

    fn put_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult {
        self.put_form_with_limit(url, form, headers, DEFAULT_RESPONSE_LIMIT)
    }

    fn put_form_with_limit(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> HttpResult {
        let mut req = self.agent.put(url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        to_response(req.send_form(form.iter().copied()), max_bytes)
    }

    fn post_json(&self, url: &str, body: &str, headers: &[(&str, &str)]) -> HttpResult {
        self.post_json_with_limit(url, body, headers, DEFAULT_RESPONSE_LIMIT)
    }

    fn post_json_with_limit(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> HttpResult {
        let mut req = self
            .agent
            .post(url)
            .header("Content-Type", "application/json");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        to_response(req.send(body), max_bytes)
    }

    fn get(&self, url: &str, headers: &[(&str, &str)]) -> HttpResult {
        self.get_with_limit(url, headers, DEFAULT_RESPONSE_LIMIT)
    }

    fn get_with_limit(&self, url: &str, headers: &[(&str, &str)], max_bytes: usize) -> HttpResult {
        let mut req = self.agent.get(url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        to_response(req.call(), max_bytes)
    }
}

/// Fold a `ureq` result into an [`HttpResponse`]. With `http_status_as_error`
/// off, a completed exchange (including 4xx) is `Ok`; only transport/timeout
/// failures stay `Err`.
fn to_response(
    result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    max_bytes: usize,
) -> HttpResult {
    match result {
        Ok(resp) => read_response(resp, max_bytes),
        // A transport error may quote the request URL (never a secret — the
        // client id is public and the token rides in a header/body ureq does not
        // echo), but redact defensively at the IPC boundary regardless.
        Err(err) => Err(HttpError::Transport(format!(
            "Network error contacting the provider: {err}"
        ))),
    }
}

fn read_response(mut resp: ureq::http::Response<ureq::Body>, max_bytes: usize) -> HttpResult {
    let status = resp.status().as_u16();
    let body = read_bounded(resp.body_mut().as_reader(), max_bytes)?;
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
