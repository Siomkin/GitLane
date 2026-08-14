//! The authorization-code exchange, bound by the PKCE verifier.

use serde::Deserialize;

use super::super::http::{HttpResponse, HttpTransport};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
