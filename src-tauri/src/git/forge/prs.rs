//! Pull-request reads and writes over `gh pr`, account-pinned via `GH_TOKEN`.
//!
//! All `gh pr …` argument construction lives in this module tree — including
//! the pure argument builders exercised by tests — so the exact flag order
//! stays in one place. Transport goes through [`super::cli::run_gh`] and
//! response shapes through [`super::dto`]; the output domain types come from
//! [`crate::git::types`].
//!
//! The operations live in focused modules under `prs/` — `reads`, `commits`,
//! `stacks`, `merge`, `mutations` — and are re-exported flat from here
//! (GL-341); the shared argument builders every child routes through stay in
//! this facade.

mod commits;
mod merge;
mod mutations;
mod reads;
mod stacks;

pub use commits::pr_commits;
pub use merge::merge_pr;
pub use mutations::{approve_pr, create_pr, reviewer_candidates, set_pr_state};
pub use reads::{list_prs, pr_checks, pr_detail};
pub use stacks::{link_stack, list_stacks, merge_stack, pr_stack};

/// Attach the validated repository target to a `gh pr` argument vector. Every
/// PR command in this module goes through this helper so none can infer a host
/// from the workdir's remote after the selected account token is loaded.
fn target_repository<'a>(mut args: Vec<&'a str>, repository: &'a str) -> Vec<&'a str> {
    args.push("--repo");
    args.push(repository);
    args
}

/// Argument vector for a `$owner`/`$name`/`$number` GraphQL read against the
/// validated host. Shared by every PR-scoped GraphQL query here so the hostname
/// pinning lives in exactly one place.
fn graphql_args<'a>(
    host: &'a str,
    query_field: &'a str,
    owner_field: &'a str,
    name_field: &'a str,
    number_field: &'a str,
) -> Vec<&'a str> {
    vec![
        "api",
        "--hostname",
        host,
        "graphql",
        "-f",
        query_field,
        "-f",
        owner_field,
        "-f",
        name_field,
        "-F",
        number_field,
    ]
}

/// `gh api --hostname <host> <path>` — a plain REST GET against the validated
/// authority. `--hostname` is explicit for the same reason as in the GraphQL
/// builder: gh would otherwise target its default host.
fn gh_api_args<'a>(host: &'a str, path: &'a str) -> Vec<&'a str> {
    vec!["api", "--hostname", host, path]
}

#[cfg(test)]
const TARGET: &str = "ghe.example.test:8443/octo/app";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graphql_commit_args_target_the_validated_authority() {
        assert_eq!(
            graphql_args(
                "ghe.example.test:8443",
                "query=q",
                "owner=octo",
                "name=app",
                "number=7",
            ),
            vec![
                "api",
                "--hostname",
                "ghe.example.test:8443",
                "graphql",
                "-f",
                "query=q",
                "-f",
                "owner=octo",
                "-f",
                "name=app",
                "-F",
                "number=7",
            ]
        );
    }
}
