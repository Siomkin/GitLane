//! Static per-provider OAuth configuration and public client-id resolution
//! (GL-139).
//!
//! Everything here is non-secret: OAuth endpoints, the minimal scopes GitLane
//! requests, the git transport-username sentinel, and the *public* client id. A
//! public client id is not a credential — it identifies the registered GitLane
//! app during device/PKCE flows (the device code / PKCE verifier are the actual
//! proof), so it is safe to compile in and to override per host.

/// Which OAuth flow a provider uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OauthFlow {
    /// OAuth 2.0 Device Authorization Grant (RFC 8628) — GitLab.
    Device,
    /// Authorization Code + PKCE over a `127.0.0.1` loopback (RFC 8252) —
    /// Bitbucket, which has no device flow.
    Pkce,
}

/// Static configuration for one supported provider.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub flow: OauthFlow,
    /// Space-separated minimal scopes for git transport + identity resolution.
    pub scopes: &'static str,
    /// The git HTTPS username an OAuth access token authenticates as.
    pub transport_username: &'static str,
}

/// The resolved endpoints for a provider on a specific host. GitLab is
/// host-parameterised (self-managed instances); Bitbucket Cloud is fixed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    /// Device-authorization endpoint (device flow only).
    pub device_authorization: Option<String>,
    /// Authorize endpoint (PKCE flow only).
    pub authorize: Option<String>,
    /// Token endpoint (both flows).
    pub token: String,
    /// User/whoami endpoint for post-token identity validation.
    pub user_api: String,
}

/// Static config for `provider`, or `None` when GitLane has no native OAuth for
/// it.
pub fn provider_config(provider: &str) -> Option<ProviderConfig> {
    match provider {
        "gitlab" => Some(ProviderConfig {
            flow: OauthFlow::Device,
            // read/write_repository authenticate git HTTPS; read_user resolves
            // the account identity used as the stable keychain locator.
            scopes: "read_repository write_repository read_user",
            transport_username: "oauth2",
        }),
        "bitbucket" => Some(ProviderConfig {
            flow: OauthFlow::Pkce,
            scopes: "account repository repository:write",
            transport_username: "x-token-auth",
        }),
        _ => None,
    }
}

/// Whether GitLane implements native OAuth for `provider`.
pub fn is_supported(provider: &str) -> bool {
    provider_config(provider).is_some()
}

/// Resolve the endpoints for `provider` on `host`. Returns `None` for an
/// unsupported provider or a syntactically invalid host (defence against URL
/// injection — `host` originates from a remote URL).
pub fn endpoints(provider: &str, host: &str) -> Option<Endpoints> {
    if !is_valid_host(host) {
        return None;
    }
    match provider {
        "gitlab" => Some(Endpoints {
            device_authorization: Some(format!("https://{host}/oauth/authorize_device")),
            authorize: None,
            token: format!("https://{host}/oauth/token"),
            user_api: format!("https://{host}/api/v4/user"),
        }),
        // Bitbucket Cloud only. Bitbucket Server/Data Center is a different
        // product with a different OAuth surface and is out of scope.
        "bitbucket" if is_bitbucket_cloud(host) => Some(Endpoints {
            device_authorization: None,
            authorize: Some("https://bitbucket.org/site/oauth2/authorize".to_string()),
            token: "https://bitbucket.org/site/oauth2/access_token".to_string(),
            user_api: "https://api.bitbucket.org/2.0/user".to_string(),
        }),
        _ => None,
    }
}

fn is_bitbucket_cloud(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    h == "bitbucket.org"
}

/// The compile-time built-in public client id for `provider`, injected at build
/// time via `GITLANE_<PROVIDER>_OAUTH_CLIENT_ID`. Empty/unset until the GitLane
/// OAuth app is registered — in which case the flow falls back to a per-host
/// override or the PAT path.
pub fn builtin_client_id(provider: &str) -> Option<&'static str> {
    let id = match provider {
        "gitlab" => option_env!("GITLANE_GITLAB_OAUTH_CLIENT_ID"),
        "bitbucket" => option_env!("GITLANE_BITBUCKET_OAUTH_CLIENT_ID"),
        _ => None,
    };
    id.map(str::trim).filter(|s| !s.is_empty())
}

/// A syntactically valid HTTPS authority (`host` or `host:port`) — the only
/// shape we will interpolate into a provider URL. Mirrors the stricter check in
/// `transport_auth::validate_credential_authority`.
pub fn is_valid_host(host: &str) -> bool {
    let value = host.trim();
    if value.is_empty() {
        return false;
    }
    let (name, port) = match value.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (name, Some(port))
        }
        Some(_) => return false,
        None => (value, None),
    };
    if port == Some("0") {
        return false;
    }
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_providers_expose_flow_and_scopes() {
        let gl = provider_config("gitlab").unwrap();
        assert_eq!(gl.flow, OauthFlow::Device);
        assert_eq!(gl.transport_username, "oauth2");
        let bb = provider_config("bitbucket").unwrap();
        assert_eq!(bb.flow, OauthFlow::Pkce);
        assert_eq!(bb.transport_username, "x-token-auth");
        assert!(provider_config("github").is_none());
        assert!(provider_config("gitea").is_none());
    }

    #[test]
    fn gitlab_endpoints_are_host_parameterised() {
        let e = endpoints("gitlab", "gitlab.example.com").unwrap();
        assert_eq!(
            e.device_authorization.as_deref(),
            Some("https://gitlab.example.com/oauth/authorize_device")
        );
        assert_eq!(e.token, "https://gitlab.example.com/oauth/token");
        assert_eq!(e.user_api, "https://gitlab.example.com/api/v4/user");
        assert!(e.authorize.is_none());
    }

    #[test]
    fn bitbucket_endpoints_are_cloud_only() {
        let e = endpoints("bitbucket", "bitbucket.org").unwrap();
        assert!(e.authorize.is_some());
        assert_eq!(e.user_api, "https://api.bitbucket.org/2.0/user");
        // Self-hosted "bitbucket" host is not Bitbucket Cloud.
        assert!(endpoints("bitbucket", "bitbucket.example.com").is_none());
    }

    #[test]
    fn rejects_hosts_that_could_inject_into_a_url() {
        assert!(endpoints("gitlab", "gitlab.com/evil").is_none());
        assert!(endpoints("gitlab", "gitlab.com foo").is_none());
        assert!(endpoints("gitlab", "gitlab.com:abc").is_none());
        assert!(endpoints("gitlab", "gitlab.com:0").is_none());
        assert!(endpoints("gitlab", "").is_none());
        assert!(is_valid_host("gitlab.example.com:8443"));
    }
}
