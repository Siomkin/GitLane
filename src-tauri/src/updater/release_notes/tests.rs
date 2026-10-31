use super::*;
use crate::git::oauth::http::testing::MockTransport;
use crate::git::oauth::http::HttpError;
use serde_json::json;

fn release(tag: &str, prerelease: bool, body: &str) -> serde_json::Value {
    json!({
        "tag_name": tag,
        "name": format!("GitLane {tag}"),
        "body": body,
        "html_url": format!("https://github.com/Siomkin/GitLane/releases/tag/{tag}"),
        "draft": false,
        "prerelease": prerelease,
        "published_at": "2026-10-22T17:18:25Z",
    })
}

fn page(releases: Vec<serde_json::Value>) -> MockTransport {
    MockTransport::new(vec![MockTransport::ok(
        200,
        &serde_json::Value::Array(releases).to_string(),
    )])
}

fn versions(notes: &ReleaseNotes) -> Vec<&str> {
    notes.releases.iter().map(|r| r.version.as_str()).collect()
}

fn sample() -> Vec<serde_json::Value> {
    vec![
        release("v2.5.0-beta.2", true, "beta 2"),
        release("v2.5.0-beta.1", true, "beta 1"),
        release("v2.4.3", false, "three"),
        release("v2.4.2", false, "two"),
        release("v2.4.1", false, "one"),
    ]
}

#[test]
fn stable_lists_the_range_newest_first_without_prereleases() {
    let notes = fetch(&page(sample()), "2.4.1", "2.4.3", false).unwrap();
    assert_eq!(versions(&notes), ["2.4.3", "2.4.2"]);
    assert!(!notes.has_more);
}

#[test]
fn beta_includes_prereleases() {
    let notes = fetch(&page(sample()), "2.5.0-beta.1", "2.5.0-beta.2", true).unwrap();
    assert_eq!(versions(&notes), ["2.5.0-beta.2"]);
}

#[test]
fn switching_from_beta_to_stable_orders_by_semver() {
    let mut releases = sample();
    releases.insert(0, release("v2.5.0", false, "final"));
    let notes = fetch(&page(releases), "2.5.0-beta.2", "2.5.0", false).unwrap();
    assert_eq!(versions(&notes), ["2.5.0"]);
}

#[test]
fn drafts_and_unparsable_tags_are_ignored() {
    let mut draft = release("v2.4.3", false, "draft");
    draft["draft"] = json!(true);
    let notes = fetch(
        &page(vec![
            draft,
            release("beta", true, "rolling manifest"),
            release("v2.4.2", false, "two"),
        ]),
        "2.4.1",
        "2.4.3",
        true,
    )
    .unwrap();
    assert_eq!(versions(&notes), ["2.4.2"]);
}

#[test]
fn caps_the_list_and_reports_more() {
    let releases = (1..=12)
        .rev()
        .map(|patch| release(&format!("v3.0.{patch}"), false, "notes"))
        .collect();
    let notes = fetch(&page(releases), "3.0.0", "3.0.12", false).unwrap();
    assert_eq!(notes.releases.len(), MAX_RELEASES);
    assert_eq!(notes.releases[0].version, "3.0.12");
    assert!(notes.has_more);
}

#[test]
fn a_range_running_past_the_page_reports_more() {
    let releases = (1..=PER_PAGE as u64)
        .rev()
        .map(|patch| release(&format!("v4.0.{patch}"), false, "notes"))
        .collect();
    let notes = fetch(&page(releases), "3.9.0", "4.0.3", false).unwrap();
    assert_eq!(versions(&notes), ["4.0.3", "4.0.2", "4.0.1"]);
    assert!(notes.has_more);
}

#[test]
fn boilerplate_and_unsigned_footer_are_stripped() {
    let body = "Desktop builds for GitLane. Not sure which file to download? See the [install guide](https://github.com/Siomkin/GitLane#install).\r\n\r\n## What's changed\r\n\r\n- **Fixed:** a thing\n\nmacOS build is unsigned\n";
    let notes = fetch(
        &page(vec![release("v2.4.3", false, body)]),
        "2.4.2",
        "2.4.3",
        false,
    )
    .unwrap();
    assert_eq!(
        notes.releases[0].body.as_deref(),
        Some("## What's changed\n\n- **Fixed:** a thing")
    );
}

#[test]
fn a_body_with_only_boilerplate_becomes_none() {
    let body =
        "Desktop builds for GitLane. Not sure which file to download?\n\nmacOS build is unsigned";
    let notes = fetch(
        &page(vec![release("v2.4.3", false, body)]),
        "2.4.2",
        "2.4.3",
        false,
    )
    .unwrap();
    assert_eq!(notes.releases[0].body, None);
}

#[test]
fn requests_one_json_page() {
    let http = page(sample());
    fetch(&http, "2.4.1", "2.4.3", false).unwrap();
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(
        requests[0].url,
        format!("{RELEASES_API}?per_page={PER_PAGE}")
    );
    assert!(requests[0]
        .headers
        .contains(&("Accept".into(), "application/vnd.github+json".into())));
}

#[test]
fn a_non_success_status_is_an_error() {
    let http = MockTransport::new(vec![MockTransport::ok(403, "{\"message\":\"rate limit\"}")]);
    let err = fetch(&http, "2.4.1", "2.4.3", false).unwrap_err();
    assert!(err.contains("403"), "{err}");
}

#[test]
fn a_transport_failure_is_an_error() {
    let http = MockTransport::new(vec![Err(HttpError::Transport("offline".into()))]);
    assert!(fetch(&http, "2.4.1", "2.4.3", false).is_err());
}

#[test]
fn invalid_versions_are_rejected_before_any_request() {
    let http = page(sample());
    assert!(fetch(&http, "not-a-version", "2.4.3", false).is_err());
    assert_eq!(http.request_count(), 0);
}

// The boilerplate is written by the release workflow; if its wording changes,
// users would start seeing it in-app, so fail here instead.
#[test]
fn boilerplate_matches_release_workflow() {
    let workflow = include_str!("../../../../.github/workflows/release.yml");
    assert!(workflow.contains(BOILERPLATE_PREFIX));
    assert!(workflow.contains(UNSIGNED_FOOTER));
}
