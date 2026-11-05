//! `check_remote_access`: the post-save `ls-remote` check.

use super::super::support::*;
use crate::git::transport_auth::TransportCredential;

#[test]
fn check_succeeds_for_a_reachable_remote_and_fails_for_an_unknown_one() {
    let root = TempRepo::new("check-remote-access");
    let origin = root.0.join("origin.git");
    let clone = TempRepo(root.0.join("clone"));
    std::fs::create_dir_all(&clone.0).unwrap();
    git_ok_at(&root.0, &["init", "--bare", "-q", origin.to_str().unwrap()]);
    clone.git_ok(&["init", "-q"]);
    clone.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);

    assert!(check_remote_access(clone.path(), "origin", &TransportCredential::None).is_ok());
    assert!(check_remote_access(clone.path(), "missing", &TransportCredential::None).is_err());
    // An option-like name is refused before git runs.
    assert!(
        check_remote_access(clone.path(), "--upload-pack=x", &TransportCredential::None).is_err()
    );
}
