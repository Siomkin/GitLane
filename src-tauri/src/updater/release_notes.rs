//! Release notes for the versions an update steps over — the implementation
//! behind `commands::updater::list_release_notes`.
//!
//! The update manifest's `notes` is a fixed download-page line, so the real
//! notes come from the public GitHub Releases list: an unauthenticated GET made
//! here in the Rust process (the webview CSP stays IPC-only). [`select`] is pure
//! so the channel / range / boilerplate rules unit-test without a network.

use semver::Version;
use serde::{Deserialize, Serialize};

use crate::git::oauth::http::{HttpTransport, PROVIDER_JSON_RESPONSE_LIMIT};

/// Releases fetched per request. Only the first page is read.
const PER_PAGE: usize = 50;

/// The Releases API list for the repository the update manifests live on. Its
/// `owner/repo` is pinned to `STABLE_ENDPOINT`'s by a test in `updater.rs`.
pub(super) const RELEASES_API: &str = "https://api.github.com/repos/Siomkin/GitLane/releases";

/// The most versions one list shows; the UI links to GitHub for the rest.
const MAX_RELEASES: usize = 10;

/// The first line `release.yml` writes into every release body (the download
/// guide, not release notes), and the footer it appends when macOS signing was
/// off. Both are dropped; a test keeps them in step with the workflow.
const BOILERPLATE_PREFIX: &str = "Desktop builds for GitLane.";
const UNSIGNED_FOOTER: &str = "macOS build is unsigned";

/// The fields read from one GitHub Releases API entry.
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    published_at: Option<String>,
}

/// One version's notes. `published_at` is GitHub's RFC 3339 string, passed
/// through as is; `body` is markdown with the boilerplate removed, or `None`
/// when nothing is left.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    version: String,
    name: Option<String>,
    published_at: Option<String>,
    body: Option<String>,
    url: String,
}

/// The newest-first versions after the running one, up to the offered one.
/// `has_more` is set when the range holds more than the list shows, including a
/// range that runs past the fetched page.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    releases: Vec<ReleaseNote>,
    has_more: bool,
}

/// Fetch the releases page and select the notes for `(current, offered]` on the
/// channel. A non-2xx status (rate limit, outage) is an error, never an empty list.
pub fn fetch(
    http: &dyn HttpTransport,
    current: &str,
    offered: &str,
    beta: bool,
) -> Result<ReleaseNotes, String> {
    let current = parse_version(current)?;
    let offered = parse_version(offered)?;
    let url = format!("{RELEASES_API}?per_page={PER_PAGE}");
    let response = http.get_with_limit(
        &url,
        &[("Accept", "application/vnd.github+json")],
        PROVIDER_JSON_RESPONSE_LIMIT,
    )?;
    if !response.is_success() {
        return Err(format!(
            "GitHub Releases returned HTTP {}.",
            response.status
        ));
    }
    let releases: Vec<GithubRelease> = serde_json::from_str(&response.body)
        .map_err(|e| format!("Unexpected GitHub Releases response: {e}"))?;
    Ok(select(releases, &current, &offered, beta))
}

fn parse_version(raw: &str) -> Result<Version, String> {
    let trimmed = raw.trim();
    Version::parse(trimmed.strip_prefix('v').unwrap_or(trimmed))
        .map_err(|e| format!("Invalid version {raw:?}: {e}"))
}

fn select(
    releases: Vec<GithubRelease>,
    current: &Version,
    offered: &Version,
    beta: bool,
) -> ReleaseNotes {
    // A full page whose oldest release is still newer than the running version
    // means the range continues on a page that was not fetched.
    // shortcut: first page only, add Link-header pagination if users fall >50 releases behind.
    let runs_past_page = releases.len() >= PER_PAGE
        && releases
            .iter()
            .filter_map(|r| parse_version(&r.tag_name).ok())
            .min()
            .is_some_and(|oldest| oldest > *current);

    let mut matched: Vec<(Version, GithubRelease)> = releases
        .into_iter()
        .filter(|r| !r.draft && (beta || !r.prerelease))
        .filter_map(|r| parse_version(&r.tag_name).ok().map(|v| (v, r)))
        .filter(|(v, _)| v > current && v <= offered)
        .collect();
    matched.sort_by(|a, b| b.0.cmp(&a.0));
    let has_more = matched.len() > MAX_RELEASES || runs_past_page;

    let releases = matched
        .into_iter()
        .take(MAX_RELEASES)
        .map(|(version, r)| ReleaseNote {
            version: version.to_string(),
            name: r.name.filter(|n| !n.trim().is_empty()),
            published_at: r.published_at,
            body: clean_body(r.body),
            url: r.html_url,
        })
        .collect();
    ReleaseNotes { releases, has_more }
}

/// Drop the download-guide paragraph and the unsigned-build footer.
fn clean_body(body: Option<String>) -> Option<String> {
    let body = body?.replace("\r\n", "\n");
    let mut text = body.trim();
    if text.starts_with(BOILERPLATE_PREFIX) {
        text = text.split_once("\n\n").map_or("", |(_, rest)| rest).trim();
    }
    if let Some(rest) = text.strip_suffix(UNSIGNED_FOOTER) {
        text = rest.trim_end();
    }
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(test)]
mod tests;
