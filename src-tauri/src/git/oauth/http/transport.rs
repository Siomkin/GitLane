//! The [`HttpTransport`] trait every OAuth and provider REST caller talks to.

use super::types::{HttpError, HttpResponse, HttpResult};

/// Outbound HTTP for the OAuth flows. Implementors must be `Send + Sync` so the
/// transport can be shared across the blocking sign-in worker.
pub trait HttpTransport: Send + Sync {
    /// POST an `application/x-www-form-urlencoded` body. `headers` are extra
    /// request headers (e.g. `Accept: application/json`).
    fn post_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult;

    /// POST a form with an endpoint-specific response cap. Provider REST
    /// mutations can echo full PR bodies, while OAuth token calls must retain
    /// the smaller default limit.
    fn post_form_with_limit(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> HttpResult {
        let response = self.post_form(url, form, headers)?;
        enforce_response_limit(response, max_bytes)
    }

    /// PUT an `application/x-www-form-urlencoded` body. Used by the GitLab REST
    /// client (GL-140) for `PUT …/merge`; the OAuth flows never call it, so it
    /// carries a default `Method not allowed` impl the mock/ureq clients override.
    fn put_form(&self, url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> HttpResult {
        let _ = (url, form, headers);
        Err(HttpError::Transport(
            "PUT is not supported by this transport.".to_string(),
        ))
    }

    fn put_form_with_limit(
        &self,
        url: &str,
        form: &[(&str, &str)],
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> HttpResult {
        let response = self.put_form(url, form, headers)?;
        enforce_response_limit(response, max_bytes)
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

    fn post_json_with_limit(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> HttpResult {
        let response = self.post_json(url, body, headers)?;
        enforce_response_limit(response, max_bytes)
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

fn enforce_response_limit(response: HttpResponse, max_bytes: usize) -> HttpResult {
    if response.body.len() > max_bytes {
        Err(HttpError::ResponseTooLarge { limit: max_bytes })
    } else {
        Ok(response)
    }
}
