//! Force-push and the route lease it validates first.

use super::config::push_endpoint_token;
use super::push::push_destination;
use super::transport::run_push;

use super::super::operands::ensure_operand;
use crate::git::transport_auth::TransportCredential;
use crate::git::types::ForcePushRouteLease;

/// Force-push a single `branch` with the exact lease a confirmation preview
/// captured. Git refuses when the server-side destination no longer matches
/// that snapshot, even if a later fetch advanced the local remote-tracking ref.
/// Used after history is rewritten (amend, reset, rebase) on an already-pushed
/// branch.
///
/// The preview's remote and destination are compared with the freshly-resolved
/// push route before transport starts. The source refspec uses the previewed
/// local oid rather than the mutable branch name, and the explicit
/// `<destination>:<oid>` (or `<destination>:` when absent) lease never asks Git
/// to infer an expectation from live tracking state. `cred` selects the inline
/// credentials.
pub fn force_push(
    repo: &str,
    branch: &str,
    expected_oid: &str,
    route: &ForcePushRouteLease,
    cred: &TransportCredential,
) -> Result<String, String> {
    super::super::head::ensure_expected_branch_tip(repo, branch, expected_oid)?;
    ensure_operand(&route.remote)?;
    ensure_operand(&route.destination_ref)?;
    if let Some(oid) = route.destination_oid.as_deref() {
        ensure_operand(oid)?;
    }
    ensure_operand(&route.push_endpoint_token)?;
    validate_force_push_route_inner(
        repo,
        branch,
        &route.remote,
        &route.destination_ref,
        &route.push_endpoint_token,
    )?;

    let refspec = format!("{expected_oid}:{}", route.destination_ref);
    // An empty expected value is meaningful Git syntax: the destination must
    // still not exist when receive-pack applies the update.
    let lease = format!(
        "--force-with-lease={}:{}",
        route.destination_ref,
        route.destination_oid.as_deref().unwrap_or("")
    );
    // Keep the named remote as the transport operand: `remote get-url` already
    // applies Git's longest-match URL rewrite once. Feeding that resolved URL
    // back to `git push` would apply a second chained rewrite and contact a
    // different endpoint. The route check immediately precedes this spawn; as
    // with the ref guards, an external config edit in that narrow window can
    // only be eliminated by Git gaining an atomic config lease.
    run_push(repo, cred, &route.remote, &[&lease], &[&refspec])
}

fn validate_force_push_route_inner(
    repo: &str,
    branch: &str,
    expected_remote: &str,
    expected_destination: &str,
    expected_endpoint_token: &str,
) -> Result<(), String> {
    if !expected_destination.starts_with("refs/heads/") {
        return Err(format!(
            "Unsupported force-push destination {expected_destination}. Preview the force-push again."
        ));
    }
    let (remote, destination) = push_destination(repo, branch);
    if !destination.starts_with("refs/heads/") {
        return Err(format!(
            "Unsupported force-push destination {destination}. Preview the force-push again."
        ));
    }
    if remote != expected_remote || destination != expected_destination {
        return Err(format!(
            "Push destination changed from {expected_remote} {expected_destination} to {remote} {destination}. Preview the force-push again."
        ));
    }
    let endpoint_token = push_endpoint_token(repo, expected_remote)?;
    if endpoint_token != expected_endpoint_token {
        return Err(format!(
            "Push endpoint for remote '{expected_remote}' changed. Preview the force-push again."
        ));
    }
    Ok(())
}

/// Validate the previewed force-push route before resolving credentials. The
/// mutation repeats the endpoint check immediately before it spawns git, so
/// config drift at either boundary normally fails closed (subject to the same
/// narrow external config-write race as Git's other pre-spawn guards).
pub fn validate_force_push_route(
    repo: &str,
    branch: &str,
    expected_remote: &str,
    expected_destination: &str,
    expected_endpoint_token: &str,
) -> Result<(), String> {
    ensure_operand(branch)?;
    ensure_operand(expected_remote)?;
    ensure_operand(expected_destination)?;
    ensure_operand(expected_endpoint_token)?;
    validate_force_push_route_inner(
        repo,
        branch,
        expected_remote,
        expected_destination,
        expected_endpoint_token,
    )
}
