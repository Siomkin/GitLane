//! Pure remote URL authority, path, and forge classification helpers.

use std::ops::Deref;

use serde::{Deserialize, Serialize};

use super::ForgeKind;

/// The GitHub/forge API authority — the host, with an optional port, that
/// provider requests are sent to and that account bindings are compared
/// against. Deliberately a bare newtype and **not** a parsed struct: parsing
/// authorities is where the bugs live, and the IPv6-correct splitters below
/// ([`authority_hostname`], [`unbracketed_hostname`]) stay the single
/// implementation; this type only names which values are authorities so a
/// hostname, an authority-with-port, and a display host cannot be silently
/// swapped. Serializes as the bare string (the wire shape is unchanged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ApiAuthority(String);

impl ApiAuthority {
    pub fn new(authority: String) -> Self {
        Self(authority)
    }

    pub fn into_inner(self) -> String {
        self.0
    }

    /// The hostname portion of the authority, IPv6 brackets preserved.
    pub fn hostname(&self) -> &str {
        authority_hostname(&self.0)
    }

    /// The hostname with any IPv6 brackets stripped, for comparing two
    /// authorities that may spell the same address differently.
    pub fn unbracketed_hostname(&self) -> &str {
        unbracketed_hostname(&self.0)
    }

    /// The explicit numeric port, if the authority carries one.
    pub fn port(&self) -> Option<&str> {
        authority_port(&self.0)
    }

    /// Whether this authority and `other` are the same API authority:
    /// hostnames must always match; ports are compared only when *both*
    /// sides carry one (see [`authorities_match`]).
    pub fn matches(&self, other: &str) -> bool {
        authorities_match(&self.0, other)
    }

    /// Whether this authority's hostname matches a bare transport hostname
    /// (an SSH/scp remote yields only that), either spelling of an IPv6
    /// literal accepted.
    pub fn matches_hostname(&self, transport_host: &str) -> bool {
        self.unbracketed_hostname()
            .eq_ignore_ascii_case(unbracketed_hostname(transport_host))
    }
}

/// Compares against a bare authority string so assertions and tests written
/// against the old `String` field read unchanged.
impl PartialEq<&str> for ApiAuthority {
    fn eq(&self, other: &&str) -> bool {
        &self.0 == other
    }
}

impl std::fmt::Display for ApiAuthority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for ApiAuthority {
    fn from(authority: String) -> Self {
        Self(authority)
    }
}

impl From<&str> for ApiAuthority {
    fn from(authority: &str) -> Self {
        Self(authority.to_string())
    }
}

/// `gh`/`RestClient` call sites treat an authority as the string it wraps.
impl Deref for ApiAuthority {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// The explicit numeric port of a raw authority, if it carries one — the
/// slicing twin of [`authority_hostname`].
pub(crate) fn authority_port(authority: &str) -> Option<&str> {
    let host = authority_hostname(authority);
    (host.len() != authority.len()).then(|| &authority[host.len() + 1..])
}

/// Compare two API authorities. Hostnames must always match; ports are compared
/// only when *both* sides carry one.
///
/// An exact port-inclusive match cannot work: `gh` rejects any hostname
/// containing a port (`gh auth login --hostname host:8443` → "invalid
/// hostname"), so no gh account can ever carry one, and forge detection reports
/// portless hosts too. Requiring equality would make a GHES/GitLab repo whose
/// HTTPS remote has an explicit port a permanent `HostMismatch` whose remedy —
/// "choose an account for the same host" — is impossible to perform. Two
/// *explicitly different* ports are still different authorities and are
/// rejected.
pub(crate) fn authorities_match(a: &str, b: &str) -> bool {
    if !unbracketed_hostname(a).eq_ignore_ascii_case(unbracketed_hostname(b)) {
        return false;
    }
    match (authority_port(a), authority_port(b)) {
        (Some(left), Some(right)) => left == right,
        _ => true,
    }
}


/// The authority of a URL body (everything after `scheme://`), with userinfo
/// stripped.
///
/// The authority ends at the first `/`, `?`, **or** `#`. Terminating on `/`
/// alone lets a query or fragment smuggle a different host past every caller:
/// `https://real.example.test?@github.com/o/r` would parse as `github.com`
/// while git actually contacts `real.example.test`. Since this feeds the
/// transport-auth host gate, that differential decides which account's
/// credential is released.
pub(super) fn authority_of(rest: &str) -> Option<&str> {
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    // The final `@` terminates userinfo, matching the redaction and remote-URL
    // guards elsewhere.
    rest[..end].rsplit('@').next()
}

/// The index of the `host:path` separator in an scp-like remote
/// (`[user@]host:path`), or `None` when the remote is not in that form.
///
/// A bracketed IPv6 literal carries its own colons, so the separator is the
/// colon *after* the closing bracket. Which `[` opens such a literal follows
/// git's own `host_end()`: only one at the very start of the remote, or
/// directly after the `@` that ends userinfo. A bracket anywhere else is
/// ordinary text.
///
/// That rule is a security boundary, not a formatting nicety. Treating any
/// early `[` as a host literal reads `[evil.example]x@github.com:owner/repo` as
/// `github.com`, while git contacts `evil.example` — so the forge indicator, PR
/// list, and PR writes would all target a repository that has nothing to do
/// with the code being fetched.
///
/// Where git salvages a host from a malformed remote of that shape, this
/// returns `None` and the caller reports no host at all. Declining to parse is
/// safe; naming the wrong host is not.
pub(super) fn scp_separator(url: &str) -> Option<usize> {
    // The authority always precedes the first `/`, so a bracket in the path can
    // never open a host literal.
    let head = &url[..url.find('/').unwrap_or(url.len())];
    let opened = if head.starts_with('[') {
        Some(0)
    } else {
        head.find("@[").map(|at| at + 1)
    };
    let Some(open) = opened else {
        return url.find(':');
    };
    // An opened literal must close, and the separator must directly follow it.
    let close = open + url[open..].find(']')?;
    (url.as_bytes().get(close + 1) == Some(&b':')).then_some(close + 1)
}

/// The exact credential authority (`host[:port]`) from an HTTPS/SSH/scp remote
/// URL. Userinfo is stripped; ports are preserved.
pub fn credential_host_for_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("ssh://"))
        .or_else(|| trimmed.strip_prefix("git://"))
    {
        let authority = authority_of(rest)?;
        return Some(authority.trim().trim_end_matches('/').to_ascii_lowercase());
    }

    if let Some(colon) = scp_separator(trimmed) {
        let user_host = &trimmed[..colon];
        if user_host.contains('@') {
            let host = user_host.split('@').next_back()?;
            return Some(host.trim().trim_end_matches('/').to_ascii_lowercase());
        }
    }

    None
}

/// Extract the `owner/repo` path from a remote URL (scheme/host stripped,
/// trailing `.git` removed). Returns None when no path component is present.
pub(super) fn remote_path(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let rest = if let Some(after) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("ssh://"))
        .or_else(|| trimmed.strip_prefix("git://"))
    {
        // authority/path — drop the authority up to the first slash.
        let slash = after.find('/')?;
        &after[slash + 1..]
    } else {
        // scp-like form: git@host:owner/repo.git
        &trimmed[scp_separator(trimmed)? + 1..]
    };
    let path = rest.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// The API host for a remote URL, preserving a custom port only for HTTP(S) URLs
/// (whose port is the API port). Returns `None` for SSH/scp/git URLs, whose port
/// is the transport port, not the REST endpoint.
pub(super) fn api_host_for(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        credential_host_for_url(trimmed)
    } else {
        None
    }
}

/// The hostname portion of an HTTP authority, preserving brackets around IPv6
/// literals. A bracketless value with multiple colons is an IPv6 literal, not
/// a `host:port` pair.
pub(crate) fn authority_hostname(authority: &str) -> &str {
    if authority.starts_with('[') {
        let Some(close) = authority.find(']') else {
            return authority;
        };
        let host_end = close + 1;
        let suffix = &authority[host_end..];
        if suffix.is_empty()
            || suffix.strip_prefix(':').is_some_and(|port| {
                !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit())
            })
        {
            return &authority[..host_end];
        }
        return authority;
    }

    if authority.bytes().filter(|byte| *byte == b':').count() == 1 {
        match authority.rsplit_once(':') {
            Some((host, port))
                if !host.is_empty()
                    && !port.is_empty()
                    && port.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                host
            }
            _ => authority,
        }
    } else {
        authority
    }
}

/// The hostname of an authority with any IPv6 brackets stripped, for comparing
/// two authorities that may spell the same address differently.
///
/// Remote URLs always yield the bracketed form (`[::1]`), but an account host is
/// whatever the user typed and is commonly stored bare (`::1`). Comparing the
/// raw hostnames would make those a permanent mismatch whose remedy — "choose an
/// account for the same host" — cannot be performed. Brackets are pure syntax
/// here: they exist to fence the address off from a port, which the caller has
/// already split away.
pub(crate) fn unbracketed_hostname(authority: &str) -> &str {
    let host = authority_hostname(authority);
    host.strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host)
}

/// Whether a hostname carries `name` as a whole DNS label.
///
/// Self-hosted forges are named after their software (`gitlab.example.com`,
/// `gitlab-ee.corp.test`), so detection cannot anchor to the vendor domain the
/// way `github.com` does. Matching a bare substring is too loose though — it
/// classifies `notgitlab.com` and `evil-bitbucket.attacker.test` as trusted
/// forges. Requiring a whole label (optionally with a `name-` prefix, for
/// `gitlab-ee`) keeps genuine self-hosted installs while rejecting hostnames
/// that merely contain the word.
///
/// A host that legitimately *is* named after the forge (`gitlab.evil.test`) is
/// still classified as one; hostname shape alone cannot distinguish that, which
/// is why classification routes providers and error text but never authorises a
/// credential on its own — that gate is the per-host account binding.
fn has_host_label(host: &str, name: &str) -> bool {
    host.split('.')
        .any(|label| label == name || label.strip_prefix(name).is_some_and(|r| r.starts_with('-')))
}

pub(super) fn classify_host(host: &str) -> Option<ForgeKind> {
    let host = normalize_host(host);
    if host == "github.com" || host.ends_with(".github.com") {
        Some(ForgeKind::GitHub)
    } else if host == "gitlab.com" || has_host_label(&host, "gitlab") {
        Some(ForgeKind::GitLab)
    } else if host == "bitbucket.org" || has_host_label(&host, "bitbucket") {
        Some(ForgeKind::Bitbucket)
    } else if host == "dev.azure.com"
        || host == "ssh.dev.azure.com"
        || host.ends_with(".visualstudio.com")
    {
        Some(ForgeKind::AzureDevOps)
    } else if host == "codeberg.org" || has_host_label(&host, "forgejo") {
        Some(ForgeKind::Forgejo)
    } else if has_host_label(&host, "gitea") {
        Some(ForgeKind::Gitea)
    } else {
        None
    }
}

pub(super) fn remote_host(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("ssh://"))
        .or_else(|| trimmed.strip_prefix("git://"))
    {
        let authority = authority_of(rest)?;
        return Some(normalize_host(authority_hostname(authority)));
    }

    if let Some(colon) = scp_separator(trimmed) {
        let user_host = &trimmed[..colon];
        if user_host.contains('@') {
            let host = user_host.split('@').next_back()?;
            return Some(normalize_host(host));
        }
    }

    None
}

pub(super) fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('/').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_remote_url_forms() {
        assert_eq!(
            remote_host("https://github.com/owner/repo.git"),
            Some("github.com".into())
        );
        assert_eq!(
            remote_host("git@bitbucket.org:team/repo.git"),
            Some("bitbucket.org".into())
        );
        assert_eq!(
            remote_host("ssh://git@gitlab.example.com/group/repo.git"),
            Some("gitlab.example.com".into())
        );
        assert_eq!(
            remote_host("git@ssh.dev.azure.com:v3/org/project/repo"),
            Some("ssh.dev.azure.com".into())
        );
    }

    #[test]
    fn credential_host_preserves_ports_and_strips_userinfo() {
        assert_eq!(
            credential_host_for_url("https://octo@ghe.example.test:8443/owner/repo.git"),
            Some("ghe.example.test:8443".into())
        );
        assert_eq!(
            credential_host_for_url("ssh://git@gitlab.example.com:2222/group/repo.git"),
            Some("gitlab.example.com:2222".into())
        );
    }

    #[test]
    fn parses_ipv6_authorities_without_treating_address_segments_as_ports() {
        for (authority, hostname) in [
            ("[2001:db8::1]:8443", "[2001:db8::1]"),
            ("[::1]", "[::1]"),
            ("2001:db8::1", "2001:db8::1"),
            ("ghe.example.test:8443", "ghe.example.test"),
            ("ghe.example.test", "ghe.example.test"),
        ] {
            assert_eq!(authority_hostname(authority), hostname, "{authority}");
        }
    }

    #[test]
    fn remote_and_credential_hosts_agree_for_ipv6_urls() {
        for (url, expected_host, expected_authority) in [
            (
                "https://[2001:db8::1]:8443/owner/repo.git",
                "[2001:db8::1]",
                "[2001:db8::1]:8443",
            ),
            ("https://[::1]/owner/repo.git", "[::1]", "[::1]"),
            (
                "ssh://git@[2001:db8::1]:22/owner/repo.git",
                "[2001:db8::1]",
                "[2001:db8::1]:22",
            ),
            // scp-like syntax, where the address' own colons must not be read
            // as the `host:path` separator.
            (
                "git@[2001:db8::1]:owner/repo.git",
                "[2001:db8::1]",
                "[2001:db8::1]",
            ),
            ("git@[::1]:owner/repo.git", "[::1]", "[::1]"),
        ] {
            let credential_authority = credential_host_for_url(url).expect("credential authority");
            assert_eq!(credential_authority, expected_authority, "{url}");
            assert_eq!(remote_host(url).as_deref(), Some(expected_host), "{url}");
            assert_eq!(
                remote_host(url).as_deref(),
                Some(authority_hostname(&credential_authority)),
                "{url}",
            );
        }
    }

    #[test]
    fn splits_scp_like_remotes_after_an_ipv6_literal() {
        for (url, path) in [
            ("git@[2001:db8::1]:owner/repo.git", "owner/repo"),
            ("git@[::1]:owner/repo.git", "owner/repo"),
            ("git@github.com:owner/repo.git", "owner/repo"),
            // A bracket inside the path is not a host literal.
            ("git@github.com:owner/re[po", "owner/re[po"),
        ] {
            assert_eq!(remote_path(url).as_deref(), Some(path), "{url}");
        }
        // Conventional scp syntax remains parseable after the bracket-aware
        // separator change.
        assert_eq!(
            remote_host("git@github.com:o/r.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(scp_separator("git@host/no-colon-before-path"), None);
    }

    /// The security boundary the bracket rule exists for: only a `[` at the very
    /// start, or directly after the `@` ending userinfo, opens a host literal.
    /// A bracket elsewhere is ordinary text, so a remote crafted to look like one
    /// must not have its host read out of the brackets — and where the remote is
    /// malformed we decline to name a host rather than guess at one.
    #[test]
    fn refuses_to_name_a_host_from_a_spoofed_bracket() {
        // The closing bracket is not followed by the separator, so this is not a
        // host literal and the remote is not parseable as scp-like.
        for spoof in [
            "[evil.example]x@github.com:owner/repo",
            "[evil.example]@github.com:owner/repo",
            "[unclosed@github.com:owner/repo",
        ] {
            assert_eq!(scp_separator(spoof), None, "{spoof}");
            assert_eq!(remote_host(spoof), None, "{spoof}");
            assert_eq!(credential_host_for_url(spoof), None, "{spoof}");
        }

        // The legitimate spellings still parse. A bracket at the very start does
        // open a literal — `scp_separator` finds the colon after it — though
        // `remote_host` separately requires the `user@` form, so assert the
        // separator directly there and the host via the userinfo spelling.
        assert_eq!(scp_separator("[::1]:owner/repo"), Some(5));
        assert_eq!(
            remote_host("git@[2001:db8::1]:owner/repo").as_deref(),
            Some("[2001:db8::1]")
        );
        assert_eq!(
            remote_host("git@[::1]:owner/repo").as_deref(),
            Some("[::1]")
        );
        // A bracket after the path separator can never open a literal.
        assert_eq!(
            remote_host("git@github.com:owner/[not-a-host]").as_deref(),
            Some("github.com")
        );
    }

    /// Bracketing is syntax that fences an address off from a port. A remote URL
    /// always yields the bracketed spelling while a stored account host is
    /// usually bare, so comparing them raw would be a permanent mismatch.
    #[test]
    fn compares_ipv6_authorities_across_bracket_spellings() {
        assert_eq!(unbracketed_hostname("[::1]"), "::1");
        assert_eq!(unbracketed_hostname("[::1]:443"), "::1");
        assert_eq!(unbracketed_hostname("::1"), "::1");
        assert_eq!(unbracketed_hostname("[2001:db8::1]"), "2001:db8::1");
        // Ordinary hosts are untouched, with or without a port.
        assert_eq!(unbracketed_hostname("github.com"), "github.com");
        assert_eq!(unbracketed_hostname("github.com:8443"), "github.com");
        // An unmatched bracket is not stripped — it is not a literal.
        assert_eq!(unbracketed_hostname("[::1"), "[::1");
    }

    #[test]
    fn classifies_known_forge_hosts() {
        assert_eq!(classify_host("github.com"), Some(ForgeKind::GitHub));
        assert_eq!(classify_host("gitlab.example.com"), Some(ForgeKind::GitLab));
        assert_eq!(classify_host("bitbucket.org"), Some(ForgeKind::Bitbucket));
        assert_eq!(classify_host("dev.azure.com"), Some(ForgeKind::AzureDevOps));
        // Azure DevOps' own "Clone → SSH" URL uses a dedicated SSH host.
        assert_eq!(
            classify_host("ssh.dev.azure.com"),
            Some(ForgeKind::AzureDevOps)
        );
        assert_eq!(classify_host("codeberg.org"), Some(ForgeKind::Forgejo));
        assert_eq!(classify_host("gitea.company.test"), Some(ForgeKind::Gitea));
        // Self-hosted installs keep working, including a `-suffix` variant.
        assert_eq!(
            classify_host("gitlab-ee.corp.test"),
            Some(ForgeKind::GitLab)
        );
    }

    #[test]
    fn classification_requires_a_whole_host_label() {
        // A hostname that merely *contains* the forge name is not that forge.
        for host in [
            "notgitlab.com",
            "evil-bitbucket.attacker.test",
            "mygitea.example.com",
            "gitlabber.io",
        ] {
            assert_eq!(classify_host(host), None, "{host} must not be classified");
        }
    }

    #[test]
    fn authority_parsing_is_not_fooled_by_query_or_fragment() {
        // Only `/` used to end the authority, so a `?`/`#` could name a
        // different host than the one git actually contacts — and this parser
        // decides which account's credential is released.
        for url in [
            "https://real.example.test?@github.com/o/r.git",
            "https://real.example.test#@github.com/o/r.git",
        ] {
            assert_eq!(
                credential_host_for_url(url).as_deref(),
                Some("real.example.test"),
                "{url} must resolve to the host git contacts",
            );
            assert_eq!(remote_host(url).as_deref(), Some("real.example.test"));
        }
        // Userinfo before a genuine path separator still resolves normally.
        assert_eq!(
            credential_host_for_url("https://alice@ghe.example.test:8443/o/r.git").as_deref(),
            Some("ghe.example.test:8443")
        );
    }

    #[test]
    fn parses_owner_repo_path_from_remote_urls() {
        assert_eq!(
            remote_path("https://github.com/owner/repo.git").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(
            remote_path("git@bitbucket.org:team/repo.git").as_deref(),
            Some("team/repo")
        );
        assert_eq!(
            remote_path("ssh://git@gitlab.example.com/group/sub/repo.git").as_deref(),
            Some("group/sub/repo")
        );
    }
}
