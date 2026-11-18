//! Preconditions for rewriting a branch without checking it out.

pub(super) fn ensure_target(repo: &str, branch: &str, expected: &str) -> Result<(), String> {
    let repository = git2::Repository::discover(repo).map_err(|e| e.to_string())?;
    let reference = repository
        .find_reference(&format!("refs/heads/{branch}"))
        .map_err(|e| read_error(branch, &e))?;
    let oid = git2::Oid::from_str(expected).map_err(|e| e.to_string())?;
    // Symbolic refs have no direct target, even if they resolve to this oid.
    if reference.target() != Some(oid) {
        return Err("Target branch changed. Refresh and try again.".to_string());
    }
    super::super::worktrees::ensure_branch_unclaimed(repo, branch, "squash")
}

/// A missing branch is a stale view; anything else (a corrupt loose ref, an
/// unreadable file) keeps libgit2's cause so it isn't mistaken for one.
fn read_error(branch: &str, e: &git2::Error) -> String {
    if e.code() == git2::ErrorCode::NotFound {
        "Target branch changed or was deleted. Refresh and try again.".to_string()
    } else {
        format!("Could not read refs/heads/{branch}: {e}")
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_target;

    fn empty_repo(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gitlane-squash-target-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        git2::Repository::init(&dir).expect("init a scratch repository");
        dir
    }

    const OID: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn a_deleted_branch_reads_as_a_stale_view() {
        let dir = empty_repo("deleted");
        let error = ensure_target(dir.to_str().expect("utf-8 temp path"), "gone", OID)
            .expect_err("a missing branch must refuse");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            error.contains("Target branch changed or was deleted"),
            "{error}"
        );
    }

    #[test]
    fn a_malformed_loose_ref_keeps_its_cause() {
        let dir = empty_repo("malformed");
        std::fs::write(dir.join(".git/refs/heads/broken"), "not an oid\n")
            .expect("write a garbage loose ref");
        let error = ensure_target(dir.to_str().expect("utf-8 temp path"), "broken", OID)
            .expect_err("a corrupt ref must refuse");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            error.contains("Could not read refs/heads/broken"),
            "{error}"
        );
    }
}
