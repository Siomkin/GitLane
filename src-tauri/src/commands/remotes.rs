//! Remote transport (pull/fetch/push/publish/force-push, remote tag+branch deletes) and remote configuration.

use super::{blocking, sync, CommandError};
use crate::git;
use crate::git::types::{GitTransportAuthRef, RemoteAccountRef, RemoteInfo, RepoForge};

/// Resolve transport credentials for one remote. `"."` — git's pseudo-remote
/// for a branch tracking another *local* branch — has no URL and must never
/// reach credential resolution: it would fail with a misleading
/// "Remote '.' was not found" error (or, worse, resolve a credential against
/// the wrong authority). Every transport command routes through this, so no
/// site can forget the rule.
pub(crate) fn transport_cred(
    path: &str,
    remote: &str,
    direction: git::transport_auth::RemoteTransportDirection,
    auth: Option<&GitTransportAuthRef>,
) -> Result<git::transport_auth::TransportCredential, String> {
    if remote == "." {
        return Ok(git::transport_auth::TransportCredential::None);
    }
    git::transport_auth::credential_for_remote(path, remote, direction, auth)
}

/// The remote a tag push targets: the explicit one, else the repo's default
/// push remote, else "origin".
///
/// Git's "." pseudo-remote is rejected from *both* sources, not just the
/// derived one: `push --delete . refs/tags/v1` deletes the local tag and leaves
/// the remote copy for the next fetch to resurrect, so it is never a valid tag
/// operand no matter who supplied it. Branch pushes resolve their remote
/// elsewhere and still accept "." deliberately.
pub(crate) fn push_remote_or_default(path: &str, remote: Option<String>) -> String {
    remote
        .filter(|r| r != ".")
        .or_else(|| git::forge::default_push_remote(path))
        .unwrap_or_else(|| "origin".to_string())
}

/// Push a tag to `remote` (the default push remote when not given), optionally
/// pinned to that remote's bound GitHub account. The token is resolved
/// server-side via the provider, never passed in from the frontend.
#[tauri::command]
pub async fn push_tag(
    path: String,
    name: String,
    remote: Option<String>,
    auth: Option<GitTransportAuthRef>,
) -> Result<String, CommandError> {
    blocking(move || {
        let remote = push_remote_or_default(&path, remote);
        let cred = transport_cred(
            &path,
            &remote,
            git::transport_auth::RemoteTransportDirection::Push,
            auth.as_ref(),
        )?;
        git::write::remotes::push_tag(&path, &name, &remote, &cred)
    })
    .await
}

/// Delete a tag on `remote` (the default push remote when not given),
/// optionally pinned to that remote's bound GitHub account. Token is resolved
/// server-side. Local deletion is the separate [`crate::commands::tags::delete_tag`] —
/// without the remote delete, fetch's `refs/tags/*` import resurrects a locally
/// deleted tag that still exists upstream.
#[tauri::command]
pub async fn delete_remote_tag(
    path: String,
    name: String,
    expected_oid: String,
    remote: Option<String>,
    auth: Option<GitTransportAuthRef>,
) -> Result<String, CommandError> {
    blocking(move || {
        let remote = push_remote_or_default(&path, remote);
        let cred = transport_cred(
            &path,
            &remote,
            git::transport_auth::RemoteTransportDirection::Push,
            auth.as_ref(),
        )?;
        git::write::remotes::delete_remote_tag(&path, &remote, &name, &expected_oid, &cred)
    })
    .await
}

/// Delete `branch` on `remote`, optionally pinned to that remote's bound
/// GitHub account. Token is resolved server-side.
#[tauri::command]
pub async fn delete_remote_branch(
    path: String,
    remote: String,
    branch: String,
    expected_oid: String,
    auth: Option<GitTransportAuthRef>,
) -> Result<String, CommandError> {
    blocking(move || {
        let cred = transport_cred(
            &path,
            &remote,
            git::transport_auth::RemoteTransportDirection::Push,
            auth.as_ref(),
        )?;
        git::write::remotes::delete_remote_branch(&path, &remote, &branch, &expected_oid, &cred)
    })
    .await
}

/// Force-push a specific `branch` with `--force-with-lease`, optionally pinned
/// to the target remote's bound GitHub account. The account is validated
/// against the branch's push remote, so a stale binding fails loudly instead of
/// pushing with the wrong token. Token is resolved server-side.
#[tauri::command]
pub async fn force_push(
    path: String,
    branch: String,
    expected_oid: String,
    route: git::types::ForcePushRouteLease,
    auth: Option<GitTransportAuthRef>,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::remotes::validate_force_push_route(
            &path,
            &branch,
            &route.remote,
            &route.destination_ref,
            &route.push_endpoint_token,
        )?;
        let cred = transport_cred(
            &path,
            &route.remote,
            git::transport_auth::RemoteTransportDirection::Push,
            auth.as_ref(),
        )?;
        git::write::remotes::force_push(&path, &branch, &expected_oid, &route, &cred)
    })
    .await
}

#[tauri::command]
pub async fn pull(
    path: String,
    branch: String,
    expected_oid: String,
    auth: Option<GitTransportAuthRef>,
) -> Result<String, CommandError> {
    blocking(move || {
        let (remote, merge_ref) = git::write::remotes::branch_pull_target(&path, &branch)?;
        let cred = transport_cred(
            &path,
            &remote,
            git::transport_auth::RemoteTransportDirection::Fetch,
            auth.as_ref(),
        )?;
        git::write::remotes::pull_branch(&path, &branch, &expected_oid, &remote, &merge_ref, &cred)
    })
    .await
}

/// Fetch + prune every non-skipped remote, each authenticated from its own
/// **fetch URL** (GL-129, git-native): the account lives in that URL's username;
/// `remote_accounts` only says which remotes need inline transport auth.
/// Unlisted remotes fetch through the system credential helpers / SSH. These
/// auth refs never carry tokens — helpers serve git directly, selected by the
/// fetch URL authority and username.
#[tauri::command]
pub async fn fetch(
    path: String,
    remote_accounts: Option<Vec<RemoteAccountRef>>,
) -> Result<String, CommandError> {
    blocking(move || {
        let mut cred_by_remote = std::collections::HashMap::new();
        for pair in remote_accounts.unwrap_or_default() {
            match transport_cred(
                &path,
                &pair.remote,
                git::transport_auth::RemoteTransportDirection::Fetch,
                Some(&pair.auth),
            ) {
                Ok(git::transport_auth::TransportCredential::None) => {}
                Ok(cred) => {
                    cred_by_remote.insert(pair.remote, cred);
                }
                Err(err) if err.contains("was not found or has no URL configured") => {}
                Err(err) => return Err(err),
            }
        }
        git::write::remotes::fetch(&path, &cred_by_remote)
    })
    .await
}

/// Push a specific `branch` (used when it isn't the checked-out branch) to its
/// configured remote, falling back to origin. Token is resolved server-side
/// from the target remote's bound `account`.
#[tauri::command]
pub async fn push_branch(
    path: String,
    branch: String,
    expected_oid: String,
    auth: Option<GitTransportAuthRef>,
) -> Result<String, CommandError> {
    blocking(move || {
        let remote = git::write::remotes::branch_push_remote(&path, &branch);
        let cred = transport_cred(
            &path,
            &remote,
            git::transport_auth::RemoteTransportDirection::Push,
            auth.as_ref(),
        )?;
        git::write::remotes::push_branch(&path, &branch, &expected_oid, &cred)
    })
    .await
}

/// Publish a local branch to `upstream` (`remote/branch`) and set upstream in
/// one push. Token is resolved server-side from the target remote's bound
/// `account`.
#[tauri::command]
pub async fn publish_branch(
    path: String,
    branch: String,
    expected_oid: String,
    upstream: String,
    auth: Option<GitTransportAuthRef>,
) -> Result<String, CommandError> {
    blocking(move || {
        let remote = git::write::remotes::publish_remote(&path, &upstream)?;
        let cred = transport_cred(
            &path,
            &remote,
            git::transport_auth::RemoteTransportDirection::Push,
            auth.as_ref(),
        )?;
        git::write::remotes::publish_branch(&path, &branch, &expected_oid, &upstream, &cred)
    })
    .await
}

/// Detect the open repo's remote forge for the toolbar provider indicator.
/// A cheap synchronous libgit2 read of the configured remotes (no network, no
/// auth probing) — kept sync like the other `read.rs`-style reads; only
/// shell-outs and the heavy `commit_graph` walk use `blocking()`.
#[tauri::command]
pub fn repo_forge(path: String) -> Result<RepoForge, CommandError> {
    sync(|| Ok::<_, CommandError>(git::forge::summary(&path)))
}

/// List the repo's configured remotes (Repository settings → Remotes). Cheap
/// synchronous libgit2 read, like the other `read.rs` reads.
#[tauri::command]
pub fn list_remotes(path: String) -> Result<Vec<RemoteInfo>, CommandError> {
    sync(|| git::read::list_remotes(&path))
}

/// Add a new remote `name` → `url` (`git remote add`).
#[tauri::command]
pub async fn add_remote(path: String, name: String, url: String) -> Result<String, CommandError> {
    blocking(move || git::write::remotes::add_remote(&path, &name, &url)).await
}

/// Repoint an existing remote at a new `url` (`git remote set-url`).
#[tauri::command]
pub async fn set_remote_url(
    path: String,
    name: String,
    url: String,
) -> Result<String, CommandError> {
    blocking(move || git::write::remotes::set_remote_url(&path, &name, &url)).await
}

/// Rewrite only the HTTPS username used for a remote's git-credential context,
/// preserving distinct fetch/push URL hosts and paths.
#[tauri::command]
pub async fn set_remote_username(
    path: String,
    name: String,
    username: Option<String>,
) -> Result<String, CommandError> {
    blocking(move || git::write::remotes::set_remote_username(&path, &name, username.as_deref()))
        .await
}

/// Remove a remote (`git remote remove`).
#[tauri::command]
pub async fn remove_remote(path: String, name: String) -> Result<String, CommandError> {
    blocking(move || git::write::remotes::remove_remote(&path, &name)).await
}
