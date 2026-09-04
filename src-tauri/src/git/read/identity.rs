//! Repository-local commit identity reads.

use git2::{Config, ConfigLevel};

use crate::git::types::RepoIdentity;

use super::repo::open;

/// The default commit identity git falls back to when nothing is pinned in a
/// repo's local config — the resolved global / system / XDG config. Read from
/// libgit2's default config (no repo), so it mirrors `~/.gitconfig`. Powers the
/// "Default git identity" option in the Identity panel. `None` when the user has
/// no global name/email set. Signing fields are surfaced too so the default
/// option can show whether global config already signs.
pub fn default_identity() -> Option<RepoIdentity> {
    identity_from_config(&Config::open_default().ok()?)
}

/// The reading half, taking an already-opened config so tests can hand it a
/// fixture file. `Config::open_default` resolves through `HOME` /
/// `GIT_CONFIG_GLOBAL`, which are process-global — a test that set them would
/// race every other test in this binary.
fn identity_from_config(cfg: &Config) -> Option<RepoIdentity> {
    let name = cfg.get_string("user.name").ok().filter(|s| !s.is_empty())?;
    let email = cfg
        .get_string("user.email")
        .ok()
        .filter(|s| !s.is_empty())?;
    let signing_key = cfg
        .get_string("user.signingkey")
        .ok()
        .filter(|s| !s.is_empty());
    let gpg_format = cfg.get_string("gpg.format").ok().filter(|s| !s.is_empty());
    let gpg_sign = cfg.get_bool("commit.gpgsign").ok();
    let tag_gpg_sign = cfg.get_bool("tag.gpgsign").ok();
    Some(RepoIdentity {
        name,
        email,
        signing_key,
        gpg_format,
        gpg_sign,
        tag_gpg_sign,
    })
}

/// The commit identity pinned in this repo's **local** git config.
///
/// We deliberately read the `Local` config level only (not the resolved
/// view that also includes global/system) so the result reflects what is
/// *pinned on this repo* — the same thing `set_repo_identity` writes via
/// `git config --local`. This is the durable, build-independent source of
/// truth the UI hydrates from on open, so a pinned identity survives a
/// restart regardless of which webview's `localStorage` is in play. Returns
/// `None` when no local identity is set (the repo defers to global config).
pub fn repo_identity(path: &str) -> Result<Option<RepoIdentity>, git2::Error> {
    let repo = open(path)?;
    let cfg = repo.config()?;
    // Every git repo has a local config file; if it can't be opened, treat the
    // repo as having no pinned identity rather than erroring.
    let Ok(local) = cfg.open_level(ConfigLevel::Local) else {
        return Ok(None);
    };
    let name = local.get_string("user.name").ok();
    let email = local.get_string("user.email").ok();
    match (name, email) {
        (Some(name), Some(email)) if !name.is_empty() && !email.is_empty() => {
            // Signing config is surfaced alongside a present identity so the UI
            // can show "this repo signs as <key>" and match it against a saved
            // profile. An empty value is treated as unset.
            let signing_key = local
                .get_string("user.signingkey")
                .ok()
                .filter(|s| !s.is_empty());
            let gpg_format = local
                .get_string("gpg.format")
                .ok()
                .filter(|s| !s.is_empty());
            let gpg_sign = local.get_bool("commit.gpgsign").ok();
            let tag_gpg_sign = local.get_bool("tag.gpgsign").ok();
            Ok(Some(RepoIdentity {
                name,
                email,
                signing_key,
                gpg_format,
                gpg_sign,
                tag_gpg_sign,
            }))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway gitconfig file that cleans itself up on drop.
    struct TempConfig(std::path::PathBuf);

    impl TempConfig {
        fn new(tag: &str, body: &str) -> Self {
            static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("gitlane-identity-{tag}-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("gitconfig");
            std::fs::write(&path, body).unwrap();
            TempConfig(path)
        }
        fn open(&self) -> Config {
            Config::open(&self.0).unwrap()
        }
    }

    impl Drop for TempConfig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
        }
    }

    #[test]
    fn reads_name_email_and_the_signing_fields() {
        let cfg = TempConfig::new(
            "full",
            "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n\tsigningkey = F5864E187596D117\n\
             [gpg]\n\tformat = openpgp\n[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = false\n",
        );

        let identity = identity_from_config(&cfg.open()).expect("a complete identity");

        assert_eq!(identity.name, "Ada Lovelace");
        assert_eq!(identity.email, "ada@example.com");
        assert_eq!(identity.signing_key.as_deref(), Some("F5864E187596D117"));
        assert_eq!(identity.gpg_format.as_deref(), Some("openpgp"));
        assert_eq!(identity.gpg_sign, Some(true));
        assert_eq!(identity.tag_gpg_sign, Some(false));
    }

    #[test]
    fn a_config_without_both_name_and_email_has_no_default_identity() {
        // The Identity panel offers "Default git identity" only when git could
        // actually author a commit with it, so either field missing means None.
        let name_only = TempConfig::new("name-only", "[user]\n\tname = Ada\n");
        assert!(identity_from_config(&name_only.open()).is_none());

        let email_only = TempConfig::new("email-only", "[user]\n\temail = ada@example.com\n");
        assert!(identity_from_config(&email_only.open()).is_none());

        let empty = TempConfig::new("empty", "");
        assert!(identity_from_config(&empty.open()).is_none());
    }

    #[test]
    fn an_empty_string_counts_as_unset() {
        // `git config user.name ""` leaves the key present but useless.
        let cfg = TempConfig::new("blank", "[user]\n\tname = \n\temail = ada@example.com\n");

        assert!(identity_from_config(&cfg.open()).is_none());
    }

    #[test]
    fn signing_fields_are_optional() {
        let cfg = TempConfig::new(
            "minimal",
            "[user]\n\tname = Ada\n\temail = ada@example.com\n",
        );

        let identity = identity_from_config(&cfg.open()).expect("name + email is enough");

        assert_eq!(identity.signing_key, None);
        assert_eq!(identity.gpg_format, None);
        assert_eq!(identity.gpg_sign, None);
    }
}
