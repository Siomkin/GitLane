//! `gh` CLI execution and account/token discovery for the parent [`forge`](crate::git::forge) module.
//!
//! This is the only place under `git/forge/` that constructs a `gh` subprocess
//! ([`run_gh`] owns the single `Command::new("gh")`); the PR, review-thread, and
//! diff behaviour in the parent module call through it, so transport stays in
//! one spot. [`accounts`] and [`token_for`] are re-exported by the parent as the
//! stable `git::forge::*` public API; tokens never leave the process.
//!
//! Facade over the focused submodules: `command` (the gh subprocess),
//! `capabilities` (version and capability detection), `accounts` (token and
//! account discovery), and `repo_selector`.

mod accounts;
mod capabilities;
mod command;
mod repo_selector;
#[cfg(test)]
mod tests;

pub(super) use accounts::{accounts, sign_out, token_for};
pub(super) use capabilities::ensure_supported;
pub(crate) use capabilities::GhCapabilities;
#[cfg(test)]
pub(super) use capabilities::GhVersion;
pub(super) use command::{run_gh, run_gh_with_limit};
pub(super) use repo_selector::repo_selector;
