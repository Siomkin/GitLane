use super::super::domain::GithubRepository;

/// Canonical `gh --repo` target derived from the already-validated service
/// context. Always include the authority so `gh` never falls back to inferring a
/// different host from the local remote (especially an SSH remote whose bare
/// transport hostname maps to an account API authority with a custom port).
pub(in crate::git::forge) fn repo_selector(repository: &GithubRepository) -> String {
    format!(
        "{}/{}/{}",
        repository.host, repository.owner, repository.name
    )
}
