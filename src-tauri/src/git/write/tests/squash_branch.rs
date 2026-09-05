//! Rewriting a sibling branch must not borrow the checked-out worktree.
use super::super::squash_range::squash_branch;
use super::support::*;

fn fixture(tag: &str) -> (TempRepo, Vec<String>) {
    let (repo, _) = repo_with_base_commit(tag);
    let mut oids = vec![rev_parse(&repo, "HEAD")];
    repo.git_ok(&["switch", "-c", "feature"]);
    for subject in ["one", "two", "three"] {
        std::fs::write(repo.0.join("f.txt"), subject).unwrap();
        repo.git_ok(&["add", "f.txt"]);
        repo.git_ok(&["commit", "-qm", subject]);
        oids.push(rev_parse(&repo, "HEAD"));
    }
    repo.git_ok(&["switch", "main"]);
    (repo, oids)
}

fn squash(repo: &TempRepo, tip: &str, newest: &str, parent: &str) -> Result<String, String> {
    squash_branch(
        repo.path(),
        "feature",
        tip,
        newest,
        parent,
        "folded",
        "",
        None,
        None,
        &crate::git::types::CapturedIdentity::NotCaptured,
    )
}

#[test]
fn squash_branch_preserves_dirty_current_work_and_recovery_ref() {
    for below_tip in [false, true] {
        let (repo, oids) = fixture("squash-other-dirty");
        repo.git_ok(&["branch", "shared", &oids[3]]);
        repo.git_ok(&["update-ref", "ORIG_HEAD", &oids[0]]);
        repo.git_ok(&["config", "core.logAllRefUpdates", "false"]);
        std::fs::write(repo.0.join("f.txt"), "staged").unwrap();
        repo.git_ok(&["add", "f.txt"]);
        std::fs::write(repo.0.join("f.txt"), "unstaged").unwrap();
        std::fs::write(repo.0.join("loose.txt"), "untracked").unwrap();
        let index = std::fs::read(repo.0.join(".git/index")).unwrap();
        let status = repo.git(&["status", "--porcelain"]).stdout;
        let tree = rev_parse(&repo, "feature^{tree}");
        let (newest, parent) = if below_tip {
            (&oids[2], &oids[0])
        } else {
            (&oids[3], &oids[1])
        };
        let result = squash(&repo, &oids[3], newest, parent).unwrap();
        assert_eq!(rev_parse(&repo, "feature"), result);
        assert_eq!(rev_parse(&repo, "feature^{tree}"), tree);
        assert_eq!(rev_parse(&repo, "HEAD"), oids[0]);
        assert_eq!(rev_parse(&repo, "ORIG_HEAD"), oids[0]);
        assert_eq!(rev_parse(&repo, "shared"), oids[3]);
        assert_eq!(
            repo.git(&["symbolic-ref", "HEAD"]).stdout,
            b"refs/heads/main\n"
        );
        assert_eq!(std::fs::read(repo.0.join(".git/index")).unwrap(), index);
        assert_eq!(
            std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
            "unstaged"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("loose.txt")).unwrap(),
            "untracked"
        );
        assert_eq!(repo.git(&["status", "--porcelain"]).stdout, status);
        let subjects = repo.git(&["log", "feature", "--format=%s"]).stdout;
        assert_eq!(
            String::from_utf8(subjects).unwrap(),
            if below_tip {
                "three\nfolded\nbase\n"
            } else {
                "folded\none\nbase\n"
            }
        );
        let reflog = std::fs::read_to_string(repo.0.join(".git/logs/refs/heads/feature")).unwrap();
        assert!(reflog
            .lines()
            .last()
            .unwrap()
            .starts_with(&format!("{} {}", oids[3], result)));
    }
}

#[test]
fn squash_branch_refuses_stale_deleted_symbolic_or_checked_out_targets() {
    for case in ["stale", "deleted", "symbolic", "current", "linked"] {
        let (repo, oids) = fixture("squash-other-target");
        match case {
            "stale" => repo.git_ok(&["update-ref", "refs/heads/feature", &oids[2]]),
            "deleted" => repo.git_ok(&["branch", "-D", "feature"]),
            "symbolic" => repo.git_ok(&["symbolic-ref", "refs/heads/feature", "refs/heads/main"]),
            "current" => repo.git_ok(&["switch", "feature"]),
            "linked" => repo.git_ok(&[
                "worktree",
                "add",
                repo.0.join("linked").to_str().unwrap(),
                "feature",
            ]),
            _ => unreachable!(),
        }
        let head = rev_parse(&repo, "HEAD");
        let refs = repo.git(&["show-ref"]).stdout;
        let error = squash(&repo, &oids[3], &oids[3], &oids[1]).unwrap_err();
        assert!(
            error.contains("changed") || error.contains("checked out"),
            "{case}: {error}"
        );
        assert_eq!(repo.git(&["show-ref"]).stdout, refs);
        assert_eq!(rev_parse(&repo, "HEAD"), head);
    }
}

#[test]
fn squash_branch_refuses_published_merges_and_invalid_ranges() {
    for case in ["published", "merge", "single", "unrelated", "mutable-oid"] {
        let (repo, oids) = fixture("squash-other-range");
        let mut tip = oids[3].clone();
        let mut parent = oids[1].clone();
        match case {
            "published" => repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &tip]),
            "merge" => {
                repo.git_ok(&["switch", "-c", "side", &oids[0]]);
                std::fs::write(repo.0.join("side.txt"), "side").unwrap();
                repo.git_ok(&["add", "side.txt"]);
                repo.git_ok(&["commit", "-qm", "side"]);
                repo.git_ok(&["switch", "feature"]);
                repo.git_ok(&["merge", "--no-ff", "-m", "merge", "side"]);
                tip = rev_parse(&repo, "HEAD");
                repo.git_ok(&["switch", "main"]);
            }
            "single" => parent = oids[2].clone(),
            "unrelated" => {
                repo.git_ok(&["switch", "--orphan", "unrelated"]);
                repo.git_ok(&["commit", "--allow-empty", "-qm", "unrelated"]);
                parent = rev_parse(&repo, "HEAD");
                repo.git_ok(&["switch", "main"]);
            }
            "mutable-oid" => parent = "main".to_string(),
            _ => unreachable!(),
        }
        let refs = repo.git(&["show-ref"]).stdout;
        assert!(squash(&repo, &tip, &tip, &parent).is_err(), "{case}");
        assert_eq!(repo.git(&["show-ref"]).stdout, refs);
        assert!(!repo.0.join(".git/ORIG_HEAD").exists() || case == "merge");
    }
}
