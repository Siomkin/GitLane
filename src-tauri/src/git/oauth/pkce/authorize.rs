//! The loopback redirect URI and the authorize URL the browser is sent to.

use crate::percent::encode_component;

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
        encode_component(client_id),
        encode_component(redirect_uri),
        encode_component(state),
        encode_component(challenge),
        encode_component(scopes),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
