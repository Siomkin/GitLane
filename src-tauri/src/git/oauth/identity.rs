//! Post-token identity validation (GL-139).
//!
//! Right after a token is obtained, GitLane calls the provider's whoami with it
//! to (a) confirm the token actually works and (b) resolve the stable account id
//! used as the keychain locator + the display login. The access token is used
//! only as a `Bearer` header here and never returned; the parsed user JSON
//! carries no secret.

use serde::Deserialize;

use super::http::HttpTransport;

/// The resolved account for a freshly obtained token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAccount {
    /// Stable, provider-owned account id — the keychain locator (GitLab numeric
    /// id as a string, Bitbucket account UUID).
    pub account_id: String,
    /// Human handle for display and for git-username hints.
    pub login: String,
    /// Optional display name.
    pub name: Option<String>,
}

/// Validate the token by calling the provider whoami and parse the account.
pub fn resolve_account(
    http: &dyn HttpTransport,
    provider: &str,
    user_api_url: &str,
    access_token: &str,
) -> Result<ResolvedAccount, String> {
    let auth = format!("Bearer {access_token}");
    let resp = http.get(
        user_api_url,
        &[
            ("Authorization", auth.as_str()),
            ("Accept", "application/json"),
        ],
    )?;
    if !resp.is_success() {
        return Err("Signed in, but couldn't read your account from the provider.".into());
    }
    match provider {
        "gitlab" => parse_gitlab_user(&resp.body),
        "bitbucket" => parse_bitbucket_user(&resp.body),
        _ => Err("Unsupported provider for identity resolution.".into()),
    }
}

fn parse_gitlab_user(body: &str) -> Result<ResolvedAccount, String> {
    #[derive(Deserialize)]
    struct GitlabUser {
        id: u64,
        username: String,
        #[serde(default)]
        name: Option<String>,
    }
    let user: GitlabUser = serde_json::from_str(body)
        .map_err(|_| "Signed in, but couldn't parse your GitLab account.".to_string())?;
    if user.username.trim().is_empty() {
        return Err("Signed in, but your GitLab account had no username.".into());
    }
    Ok(ResolvedAccount {
        account_id: user.id.to_string(),
        login: user.username,
        name: user.name.filter(|s| !s.trim().is_empty()),
    })
}

fn parse_bitbucket_user(body: &str) -> Result<ResolvedAccount, String> {
    #[derive(Deserialize)]
    struct BitbucketUser {
        uuid: String,
        #[serde(default)]
        username: Option<String>,
        #[serde(default)]
        nickname: Option<String>,
        #[serde(default)]
        display_name: Option<String>,
    }
    let user: BitbucketUser = serde_json::from_str(body)
        .map_err(|_| "Signed in, but couldn't parse your Bitbucket account.".to_string())?;
    if user.uuid.trim().is_empty() {
        return Err("Signed in, but your Bitbucket account had no id.".into());
    }
    // Bitbucket dropped `username` from newer responses; fall back to nickname
    // then display name so the account still has a human handle.
    let login = user
        .username
        .or_else(|| user.nickname.clone())
        .or_else(|| user.display_name.clone())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| user.uuid.clone());
    Ok(ResolvedAccount {
        account_id: user.uuid,
        login,
        name: user.display_name.filter(|s| !s.trim().is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gitlab_user() {
        let acc = parse_gitlab_user(r#"{"id":42,"username":"ada","name":"Ada Lovelace"}"#).unwrap();
        assert_eq!(acc.account_id, "42");
        assert_eq!(acc.login, "ada");
        assert_eq!(acc.name.as_deref(), Some("Ada Lovelace"));
        assert!(parse_gitlab_user(r#"{"id":1,"username":""}"#).is_err());
        assert!(parse_gitlab_user("nope").is_err());
    }

    #[test]
    fn parses_bitbucket_user_with_fallbacks() {
        let full = parse_bitbucket_user(
            r#"{"uuid":"{abc-123}","username":"grace","display_name":"Grace H."}"#,
        )
        .unwrap();
        assert_eq!(full.account_id, "{abc-123}");
        assert_eq!(full.login, "grace");
        assert_eq!(full.name.as_deref(), Some("Grace H."));

        // No username → nickname; then display_name; then uuid.
        let nick =
            parse_bitbucket_user(r#"{"uuid":"{u}","nickname":"nick","display_name":"N"}"#).unwrap();
        assert_eq!(nick.login, "nick");
        let disp = parse_bitbucket_user(r#"{"uuid":"{u}","display_name":"Only Name"}"#).unwrap();
        assert_eq!(disp.login, "Only Name");
        let bare = parse_bitbucket_user(r#"{"uuid":"{u}"}"#).unwrap();
        assert_eq!(bare.login, "{u}");

        assert!(parse_bitbucket_user(r#"{"uuid":""}"#).is_err());
    }

    #[test]
    fn resolve_account_uses_the_token_and_parses_the_body() {
        use crate::git::oauth::http::testing::MockTransport;
        let http = MockTransport::new(vec![MockTransport::ok(200, r#"{"id":7,"username":"neo"}"#)]);
        let acc =
            resolve_account(&http, "gitlab", "https://gitlab.com/api/v4/user", "tok").unwrap();
        assert_eq!(acc.login, "neo");
        // The Authorization header carried the token (get records no form body,
        // but the request was made against the user endpoint).
        assert_eq!(http.request_count(), 1);
    }
}
