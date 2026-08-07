//! Shared REST shell for the forge providers (GL-361).
//!
//! One deep client owns URL building, header attachment, response finishing,
//! and — critically — secret redaction, written and tested once. A forge
//! adapter supplies only what actually differs: its API base URL, its complete
//! `Authorization` value (plus every secret encoding of it, e.g. Bitbucket's
//! base64 Basic payload), and its status→error mapping. GitLab's and
//! Bitbucket's transports are thin adapters over this client; a third REST
//! forge gets the shell for free.

use crate::git::oauth::http::{HttpError, HttpResult, HttpTransport, PROVIDER_JSON_RESPONSE_LIMIT};

use super::domain::GithubError;

/// A forge's mapping from a non-2xx status onto an internal error category.
/// Categorization sees the **original** body — the 403-scope upgrade must read
/// the server's wording before redaction — and the shared client redacts the
/// message-bearing variants afterwards.
pub type MapHttpError =
    fn(operation: &'static str, host: &str, status: u16, body: &str) -> GithubError;

/// What a forge declares to get the shared REST shell.
pub struct RestConfig<'a> {
    /// Provider display name for outward messages ("GitLab", "Bitbucket").
    pub provider: &'static str,
    /// Fully-formed API base with no trailing slash (e.g. `https://{host}/api/v4`).
    pub base_url: String,
    /// The repo host, passed through to `map_error` for actionable auth guidance.
    pub host: &'a str,
    /// The complete `Authorization` header value.
    pub auth: String,
    /// The raw credential. Empty means unauthenticated — nothing to redact
    /// beyond URL-carried credentials.
    pub token: &'a str,
    /// Forge-specific encodings of the credential that must equally never
    /// escape (Bitbucket's Basic payload). Empty strings are ignored.
    pub extra_secrets: &'a [&'a str],
    pub map_error: MapHttpError,
}

/// Direct REST client over the shared [`HttpTransport`]. The token stays in
/// this process — it rides only in the request header, never a URL or log.
pub struct RestClient<'a> {
    http: &'a dyn HttpTransport,
    provider: &'static str,
    base_url: String,
    host: String,
    auth: String,
    /// Every string whose appearance in an outward message would leak the
    /// credential, most-specific first: the header line, the bare value, any
    /// forge-specific encoding, and the raw token. Empty when the token is.
    secrets: Vec<String>,
    map_error: MapHttpError,
}

impl<'a> RestClient<'a> {
    /// `config`'s borrows are copied out, so they only need to live for the
    /// call — a forge can build the auth value and its payload locally.
    pub fn new(http: &'a dyn HttpTransport, config: RestConfig<'_>) -> Self {
        let mut secrets = Vec::new();
        if !config.token.is_empty() {
            secrets.push(format!("Authorization: {}", config.auth));
            secrets.push(config.auth.clone());
            secrets.extend(
                config
                    .extra_secrets
                    .iter()
                    .filter(|s| !s.is_empty())
                    .map(|s| (*s).to_string()),
            );
            secrets.push(config.token.to_string());
        }
        Self {
            http,
            provider: config.provider,
            base_url: config.base_url,
            host: config.host.to_string(),
            auth: config.auth,
            secrets,
            map_error: config.map_error,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path)
    }

    fn headers(&self, accept: &'static str) -> [(&str, &str); 2] {
        [("Authorization", self.auth.as_str()), ("Accept", accept)]
    }

    /// GET a JSON endpoint under the standard provider response limit.
    pub fn get_json(&self, operation: &'static str, path: &str) -> Result<String, GithubError> {
        self.get_json_with_limit(operation, path, PROVIDER_JSON_RESPONSE_LIMIT)
    }

    pub fn get_json_with_limit(
        &self,
        operation: &'static str,
        path: &str,
        max_bytes: usize,
    ) -> Result<String, GithubError> {
        let headers = self.headers("application/json");
        self.finish(
            operation,
            self.http
                .get_with_limit(&self.url(path), &headers, max_bytes),
        )
    }

    /// GET an endpoint that serves a non-JSON body (e.g. a raw git patch) with
    /// `Accept: text/plain` and an explicit, typically larger, limit.
    pub fn get_text(
        &self,
        operation: &'static str,
        path: &str,
        max_bytes: usize,
    ) -> Result<String, GithubError> {
        let headers = self.headers("text/plain");
        self.finish(
            operation,
            self.http
                .get_with_limit(&self.url(path), &headers, max_bytes),
        )
    }

    /// POST a raw JSON body (nested-JSON APIs like Bitbucket's create/merge).
    pub fn post_json(
        &self,
        operation: &'static str,
        path: &str,
        body: &str,
    ) -> Result<String, GithubError> {
        let headers = self.headers("application/json");
        self.finish(
            operation,
            self.http.post_json_with_limit(
                &self.url(path),
                body,
                &headers,
                PROVIDER_JSON_RESPONSE_LIMIT,
            ),
        )
    }

    /// POST `x-www-form-urlencoded` key/value pairs (form-body APIs like GitLab).
    pub fn post_form(
        &self,
        operation: &'static str,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<String, GithubError> {
        let headers = self.headers("application/json");
        self.finish(
            operation,
            self.http.post_form_with_limit(
                &self.url(path),
                form,
                &headers,
                PROVIDER_JSON_RESPONSE_LIMIT,
            ),
        )
    }

    /// PUT `x-www-form-urlencoded` key/value pairs.
    pub fn put_form(
        &self,
        operation: &'static str,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<String, GithubError> {
        let headers = self.headers("application/json");
        self.finish(
            operation,
            self.http.put_form_with_limit(
                &self.url(path),
                form,
                &headers,
                PROVIDER_JSON_RESPONSE_LIMIT,
            ),
        )
    }

    fn redact_error_text(&self, text: &str) -> String {
        let values: Vec<&str> = self.secrets.iter().map(String::as_str).collect();
        crate::redact::redact_secrets_with_values(text, &values)
    }

    /// Scrub only message-bearing variants after status/detail classification.
    /// Categorization must see the original server response; only the outward
    /// text crossing the provider/IPC boundary is sanitized.
    fn redact_error(&self, error: GithubError) -> GithubError {
        match error {
            GithubError::Network(message) => GithubError::Network(self.redact_error_text(&message)),
            GithubError::InvalidResponse(message) => {
                GithubError::InvalidResponse(self.redact_error_text(&message))
            }
            GithubError::CommandFailed(message) => {
                GithubError::CommandFailed(self.redact_error_text(&message))
            }
            other => other,
        }
    }

    fn finish(&self, operation: &'static str, result: HttpResult) -> Result<String, GithubError> {
        match result {
            Ok(resp) if resp.is_success() => Ok(resp.body),
            Ok(resp) => {
                let error = (self.map_error)(operation, &self.host, resp.status, &resp.body);
                Err(self.redact_error(error))
            }
            Err(HttpError::ResponseTooLarge { limit }) => {
                Err(GithubError::InvalidResponse(format!(
                    "{} {operation} exceeded the {limit}-byte response limit; the partial response was discarded.",
                    self.provider
                )))
            }
            // A transport adapter may echo its request headers as well as its
            // URL. Scrub both URL credentials and this client's active secrets.
            Err(HttpError::Transport(err)) => {
                Err(GithubError::Network(self.redact_error_text(&err)))
            }
        }
    }
}

#[cfg(test)]
mod tests;
