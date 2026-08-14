//! Remote, fetch, push, and authentication-aware git writes.
//!
//! Facade over the focused submodules: `transport` (running a network command
//! under a credential), `config` (remote add/remove/url/username), `pull`,
//! `push`, `fetch`, and `force_push`.

mod config;
mod fetch;
mod force_push;
mod pull;
mod push;
mod transport;

pub use config::{add_remote, remove_remote, set_remote_url, set_remote_username};
pub use fetch::fetch;
pub use force_push::{force_push, validate_force_push_route};
pub use pull::{branch_pull_target, pull_branch};
pub use push::{
    branch_push_remote, delete_remote_branch, delete_remote_tag, publish_branch, publish_remote,
    push_branch, push_tag,
};

pub(super) use config::push_endpoint_token;
pub(super) use push::push_destination;

// Reached only by the write-path tests, which assert on the exact git output
// each of these classifies.
#[cfg(test)]
pub(super) use fetch::{is_concurrent_fetch_ref_update, is_tag_clobber_rejection};
#[cfg(test)]
pub(super) use push::{is_missing_remote_ref, push_target_at};

#[cfg(test)]
pub use pull::pull;
#[cfg(test)]
pub use push::head_push_remote;
