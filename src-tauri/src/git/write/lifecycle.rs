//! Repository lifecycle writes: **clone** (with live progress) and **init**.
//!
//! These are the only writes that operate *outside* an existing repository, so
//! they don't go through `git -C <repo>` like every other write — they use
//! [`super::cli::run_git_bare`] / a freshly spawned `git clone`. Clone is also
//! the one streaming write: it spawns `git clone --progress`, parses the phase
//! percentages off stderr, and reports them to a caller-supplied callback — which
//! `clone_repo` turns into the `clone-progress` event the onboarding UI paints a
//! determinate bar from and cancels an in-flight clone through (GL-38, GL-355).

use std::process::Child;
use std::sync::{Arc, Mutex};

use serde::Serialize;

mod clone;
mod init;
mod publish;

pub use clone::{cancel_clone, clone};
pub use init::{init, init_in_place};

/// Live clone progress, emitted to the frontend as a `clone-progress` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    /// Friendly phase label, matching the onboarding stage list.
    pub stage: String,
    /// Overall completion `0..=100`, blended across git's phases so the bar moves
    /// forward monotonically rather than resetting each phase.
    pub pct: u8,
}

/// Shared clone lifecycle. Cancellation stays sticky after the child is
/// reclaimed so it can still win the final race against publishing staging.
pub type CloneSlot = Arc<Mutex<CloneOperation>>;

#[derive(Default)]
pub struct CloneOperation {
    child: Option<Child>,
    phase: ClonePhase,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum ClonePhase {
    #[default]
    Idle,
    Running,
    Cancelled,
    Publishing,
    Committed,
}

#[cfg(test)]
mod tests {
    use super::clone::{
        claim_clone_publication, extract_error, parse_percent, parse_progress, record_transcript,
        validated_clone_destination, validated_clone_url,
    };
    use super::init::gitignore_template;
    use super::*;

    #[test]
    fn clone_url_rejects_password_userinfo_but_keeps_username_selectors() {
        assert_eq!(
            validated_clone_url(" https://alice@example.com/team/repo.git ").unwrap(),
            "https://alice@example.com/team/repo.git"
        );
        assert!(validated_clone_url("git@example.com:team/repo.git").is_ok());

        let error = validated_clone_url("https://alice:clone-secret@example.com/team/repo.git")
            .unwrap_err();
        assert!(
            error.contains("must not contain"),
            "unexpected error: {error}"
        );
        assert!(
            !error.contains("clone-secret"),
            "clone validation echoed the secret: {error}"
        );
    }

    #[test]
    fn clone_destination_rejects_dot_segments_and_both_separator_styles() {
        assert!(validated_clone_destination("/tmp/new-repo").is_ok());
        for invalid in ["", "/", "/tmp/..", "/tmp/.", r"C:\parent\.."] {
            assert!(
                validated_clone_destination(invalid).is_err(),
                "{invalid:?} should not be a clone leaf"
            );
        }
    }

    #[test]
    fn parse_percent_reads_digits_before_the_sign() {
        assert_eq!(
            parse_percent("Receiving objects:  73% (730/1000)"),
            Some(73)
        );
        assert_eq!(
            parse_percent("Resolving deltas: 100% (50/50), done."),
            Some(100)
        );
        assert_eq!(
            parse_percent("remote: Counting objects: 5% (1/20)"),
            Some(5)
        );
    }

    #[test]
    fn parse_percent_is_none_without_a_percentage() {
        assert_eq!(parse_percent("Cloning into 'repo'..."), None);
        assert_eq!(parse_percent("done."), None);
        assert_eq!(parse_percent("%"), None);
    }

    #[test]
    fn parse_progress_blends_phases_onto_a_monotonic_bar() {
        // Enumerate/count occupy the first slice.
        let counting = parse_progress("remote: Counting objects: 100% (20/20)").unwrap();
        assert_eq!(counting.stage, "Counting objects");
        assert_eq!(counting.pct, 5);

        // Receiving dominates the middle.
        let receiving = parse_progress("Receiving objects: 100% (1000/1000)").unwrap();
        assert_eq!(receiving.stage, "Receiving objects");
        assert_eq!(receiving.pct, 85);

        // Resolving + checkout finish the bar.
        let resolving = parse_progress("Resolving deltas: 100% (300/300), done.").unwrap();
        assert_eq!(resolving.stage, "Resolving deltas");
        assert_eq!(resolving.pct, 97);

        let checkout = parse_progress("Updating files: 100% (42/42), done.").unwrap();
        assert_eq!(checkout.stage, "Checking out files");
        assert_eq!(checkout.pct, 100);
    }

    #[test]
    fn parse_progress_advances_within_a_phase() {
        let early = parse_progress("Receiving objects: 0% (1/1000)").unwrap();
        let mid = parse_progress("Receiving objects: 50% (500/1000)").unwrap();
        let done = parse_progress("Receiving objects: 100% (1000/1000)").unwrap();
        assert!(early.pct < mid.pct && mid.pct < done.pct);
        assert_eq!(early.pct, 10); // base of the receiving slice
    }

    #[test]
    fn parse_progress_ignores_non_progress_lines() {
        assert!(parse_progress("Cloning into 'repo'...").is_none());
        assert!(parse_progress("fatal: repository not found").is_none());
    }

    #[test]
    fn extract_error_prefers_fatal_lines() {
        let transcript = "Cloning into 'core'...\nremote: Enumerating objects: 10\nfatal: Authentication failed for 'https://example.com/x.git'\n";
        assert_eq!(
            extract_error(transcript),
            "fatal: Authentication failed for 'https://example.com/x.git'"
        );
    }

    #[test]
    fn extract_error_keeps_the_servers_own_explanation() {
        let transcript = "Cloning into 'r'...\nremote: Enumerating objects: 10\nremote: API Token provided has no Bitbucket scopes.\nfatal: unable to access 'https://bitbucket.org/w/r.git/': The requested URL returned error: 403\n";
        assert_eq!(
            extract_error(transcript),
            "remote: API Token provided has no Bitbucket scopes.\nfatal: unable to access 'https://bitbucket.org/w/r.git/': The requested URL returned error: 403"
        );
    }

    #[test]
    fn extract_error_falls_back_to_last_line() {
        let transcript = "warning: something odd\nsome trailing note\n";
        assert_eq!(extract_error(transcript), "some trailing note");
    }

    #[test]
    fn record_transcript_is_bounded_and_char_safe() {
        let mut t = String::new();
        for _ in 0..2000 {
            record_transcript(
                &mut t,
                "Receiving objects: 50% (500/1000), 12.30 MiB | 4 MiB/s",
            );
        }
        assert!(t.len() <= 8 * 1024 + 64);
        // Still valid UTF-8 / not split mid-char (String guarantees this; the
        // boundary trim must keep it intact).
        assert!(t.is_char_boundary(0));
    }

    #[test]
    fn cancellation_wins_after_child_reclaim_but_before_publication() {
        let slot = CloneSlot::default();
        slot.lock().unwrap().phase = ClonePhase::Running;

        cancel_clone(&slot).expect("cancel before publication");

        assert!(!claim_clone_publication(&slot).expect("publication decision"));
        assert_eq!(slot.lock().unwrap().phase, ClonePhase::Idle);
    }

    #[test]
    fn publication_wins_atomically_against_a_late_cancel() {
        let slot = CloneSlot::default();
        slot.lock().unwrap().phase = ClonePhase::Running;

        assert!(claim_clone_publication(&slot).expect("claim publication"));

        assert!(cancel_clone(&slot).is_err());
        assert_eq!(slot.lock().unwrap().phase, ClonePhase::Publishing);
    }

    #[test]
    fn init_rejects_dot_segment_and_separator_names() {
        // Validation fails before any filesystem/git work, so a throwaway parent
        // is fine — nothing is created on disk.
        for bad in [".", "..", "a/b", "a\\b", ""] {
            assert!(
                super::init("/tmp", bad, "main", false, "None").is_err(),
                "init should reject name {bad:?}"
            );
        }
        assert!(
            super::init("relative-parent", "repo", "main", false, "None").is_err(),
            "init must not reinterpret a crafted relative destination"
        );
    }

    #[test]
    fn gitignore_templates_resolve_known_names_only() {
        assert!(gitignore_template("Node").is_some());
        assert!(gitignore_template("rust").is_some());
        assert!(gitignore_template("None").is_none());
        assert!(gitignore_template("").is_none());
        assert!(gitignore_template("whatever").is_none());
    }
}
