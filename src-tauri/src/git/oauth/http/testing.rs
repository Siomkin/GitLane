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
    /// Body ceiling selected by the caller. Provider JSON and raw diff
    /// endpoints opt into separate bounded allowances above OAuth's limit.
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
    fn post_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult {
        self.next("POST", url, form, None, headers, DEFAULT_RESPONSE_LIMIT)
    }

    fn post_form_with_limit(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> HttpResult {
        self.next("POST", url, form, None, headers, max_bytes)
    }

    fn put_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult {
        self.next("PUT", url, form, None, headers, DEFAULT_RESPONSE_LIMIT)
    }

    fn put_form_with_limit(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> HttpResult {
        self.next("PUT", url, form, None, headers, max_bytes)
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

    fn post_json_with_limit(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> HttpResult {
        self.next("POST", url, &[], Some(body), headers, max_bytes)
    }

    fn get(&self, url: &str, headers: &[(&str, &str)]) -> HttpResult {
        self.get_with_limit(url, headers, DEFAULT_RESPONSE_LIMIT)
    }

    fn get_with_limit(&self, url: &str, headers: &[(&str, &str)], max_bytes: usize) -> HttpResult {
        self.next("GET", url, &[], None, headers, max_bytes)
    }
}
