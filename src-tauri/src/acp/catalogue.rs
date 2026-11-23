//! The shipped adapter catalogue — the ACP agents GitLane offers, and
//! whether each one's launcher is on PATH.

use super::AcpAdapter;

/// ACP agents GitLane knows how to launch. Listing one is not a promise that it
/// is installed — `available` answers that on sight, and a failed launch says
/// why — so the catalogue can be generous. Anything absent still works as a
/// custom adapter, since the command is free text.
///
/// Six were handshaked against the real CLI on a dev machine (the five below
/// plus GitHub Copilot). Antigravity (`agy acp`, from its own --help) has
/// passed only the `initialize` handshake, against agy 1.5.14, with no full
/// session yet. Kiro and Junie carry commands from their vendors' own
/// ACP docs; the rest are from Buzz's runtime presets
/// (block/buzz, desktop/src-tauri/src/managed_agents/discovery/presets.rs),
/// which is a real source rather than a guess, but they have not been run here.
/// Most need no adapter at all: their CLI speaks ACP as `<cli> acp`. Note that
/// `cursor-agent acp` is absent from that CLI's own --help yet works, and is
/// preferred over the third-party `cursor-acp` npm packages — a native
/// subcommand beats a 0.1.x release from an unaffiliated publisher.
pub fn catalog() -> Vec<AcpAdapter> {
    ENTRIES
        .iter()
        .map(|(id, name, command, install, docs, requires)| AcpAdapter {
            id: (*id).into(),
            name: (*name).into(),
            command: (*command).into(),
            install: (*install).into(),
            docs: (*docs).into(),
            requires: (*requires).into(),
            available: crate::terminal_agents::probe_available(command),
        })
        .collect()
}

/// The catalogue's current command for one saved from an older catalogue. The
/// npx adapters used to be seeded without `@latest`, and a bare `npx -y` spec
/// keeps running whatever copy it cached first — the tag makes npx check the
/// registry on every launch, so saved rows move onto it. A row naming any
/// version is the user's choice and is kept.
pub fn current_command(command: &str) -> Option<&'static str> {
    let command = command.trim();
    npx_entries().find(|entry| entry.strip_suffix("@latest") == Some(command))
}

/// Is `command` one of the catalogue's `npx` adapters, at any version? Only
/// these are known to take the repo from the session.
pub(super) fn is_npx_adapter(command: &str) -> bool {
    let package = split_version(command.trim()).0;
    npx_entries().any(|entry| split_version(entry).0 == package)
}

fn npx_entries() -> impl Iterator<Item = &'static str> {
    ENTRIES
        .iter()
        .map(|(_, _, entry, _, _, _)| *entry)
        .filter(|entry| entry.starts_with("npx "))
}

/// Split a trailing `@<version>` off the command's last word. A scoped
/// package's leading `@` is not a version separator.
fn split_version(command: &str) -> (&str, Option<&str>) {
    // Byte offset of the last word; `rsplit` keeps a multi-byte space intact.
    let word = command.len()
        - command
            .rsplit(char::is_whitespace)
            .next()
            .unwrap_or(command)
            .len();
    match command[word..].rfind('@') {
        Some(at) if at > 0 => (&command[..word + at], Some(&command[word + at + 1..])),
        _ => (command, None),
    }
}

/// The install command the catalogue knows for `command`, if any — what a
/// launch failure should tell the user to run instead of a generic example.
/// A pure table lookup: no PATH probing, since the caller already knows the
/// launch failed.
pub(super) fn install_for(command: &str) -> Option<&'static str> {
    // Version-blind like `is_npx_adapter`: a hand-pinned adapter version still
    // gets its package's install hint.
    let package = split_version(command.trim()).0;
    ENTRIES
        .iter()
        .find(|(_, _, entry, _, _, _)| split_version(entry).0 == package)
        .map(|(_, _, _, install, _, _)| *install)
        .filter(|install| !install.is_empty())
}

// (id, name, command, install, docs, requires)
const ENTRIES: &[(&str, &str, &str, &str, &str, &str)] = &[
    (
        "claude",
        "Claude Code",
        "npx -y @agentclientprotocol/claude-agent-acp@latest",
        "npm i -g @agentclientprotocol/claude-agent-acp",
        "https://docs.claude.com/en/docs/claude-code/overview",
        "The `claude` CLI, signed in. A Pro/Max subscription drives it with no API key.",
    ),
    (
        "codex",
        "Codex",
        "npx -y @agentclientprotocol/codex-acp@latest",
        "npm i -g @agentclientprotocol/codex-acp",
        "https://developers.openai.com/codex/cli",
        "The `codex` CLI, signed in.",
    ),
    (
        "cursor",
        "Cursor",
        "cursor-agent acp",
        "",
        "https://cursor.com/downloads",
        "The `cursor-agent` CLI, signed in (`cursor-agent login`).",
    ),
    (
        "kimi",
        "Kimi Code",
        "kimi acp",
        "",
        "https://kimi.ai/download",
        "The `kimi` CLI, signed in.",
    ),
    (
        "opencode",
        "OpenCode",
        "opencode acp",
        "",
        "https://opencode.ai/docs",
        "The `opencode` CLI, with a provider configured.",
    ),
    (
        "goose",
        "Goose",
        "goose acp",
        "",
        "https://block.github.io/goose/docs/getting-started/installation",
        "The `goose` CLI, with a provider configured.",
    ),
    (
        "gemini",
        "Gemini CLI",
        "gemini --experimental-acp",
        "npm i -g @google/gemini-cli",
        "https://github.com/google-gemini/gemini-cli",
        "The `gemini` CLI, signed in.",
    ),
    (
        "antigravity",
        "Antigravity",
        // Telemetry is on unless asked; a catalogue default should not opt users in.
        "agy acp --disable-telemetry",
        "",
        "https://antigravity.google/docs/cli",
        "The `agy` CLI, signed in with Google (`agy acp --login`).",
    ),
    (
        "copilot",
        "GitHub Copilot",
        "copilot --acp",
        "npm i -g @github/copilot",
        "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
        "The `copilot` CLI, signed in to a Copilot plan.",
    ),
    (
        "kiro",
        "Kiro CLI",
        "kiro-cli acp",
        "",
        "https://kiro.dev/docs/cli/acp/",
        "The `kiro-cli` CLI, signed in.",
    ),
    (
        "junie",
        "Junie",
        "junie --acp true",
        "",
        "https://junie.jetbrains.com/docs/junie-cli-acp.html",
        "The `junie` CLI, signed in to a JetBrains AI plan.",
    ),
    (
        "devin",
        "Devin",
        "devin acp",
        "",
        "https://docs.devin.ai/cli",
        "The `devin` CLI, signed in.",
    ),
    (
        "grok",
        "Grok Build",
        // No `--always-approve`: that flag approves tool calls inside the
        // CLI, before GitLane's own permission gate ever sees them, which
        // would make the execute allowlist decorative for this one adapter.
        // If Grok then refuses to run unattended, it fails closed — the
        // right direction for a turn nobody is watching.
        "grok agent stdio",
        "",
        "https://build.x.ai/docs",
        "The `grok` CLI, signed in.",
    ),
    (
        "amp",
        "Amp",
        "amp-acp",
        "",
        "https://github.com/tao12345666333/amp-acp",
        "The `amp` CLI plus the community `amp-acp` adapter on PATH.",
    ),
    (
        "openclaw",
        "OpenClaw",
        "openclaw acp",
        "",
        "https://docs.openclaw.ai/start/getting-started",
        "The `openclaw` CLI, configured.",
    ),
    (
        "omp",
        "Oh My Pi",
        "omp acp",
        "",
        "https://omp.sh/",
        "The `omp` CLI, configured.",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_leads_with_the_adapters_verified_on_a_real_cli() {
        let adapters = catalog();
        let verified: Vec<&str> = adapters
            .iter()
            .take(5)
            .map(|a| a.command.as_str())
            .collect();
        // These five were handshaked and opened a session against the real CLI.
        // Changing one means re-probing it, not editing this list.
        assert_eq!(
            verified,
            [
                "npx -y @agentclientprotocol/claude-agent-acp@latest",
                "npx -y @agentclientprotocol/codex-acp@latest",
                // Native ACP subcommands — no adapter package involved.
                // `cursor-agent acp` is undocumented in its own --help.
                "cursor-agent acp",
                "kimi acp",
                "opencode acp",
            ]
        );
        let mut ids: Vec<&str> = adapters.iter().map(|a| a.id.as_str()).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "adapter ids must be unique");
        for adapter in &adapters {
            assert!(!adapter.name.is_empty(), "{} needs a name", adapter.id);
            assert!(
                !adapter.requires.is_empty(),
                "{} needs a login hint",
                adapter.id
            );
            // Listing an agent that is not installed is fine — `available` says
            // so — but only if there is somewhere to go next.
            assert!(
                !adapter.install.is_empty() || !adapter.docs.is_empty(),
                "{} offers neither an install command nor a docs link",
                adapter.id,
            );
        }
    }

    const CLAUDE_LATEST: &str = "npx -y @agentclientprotocol/claude-agent-acp@latest";

    #[test]
    fn a_bare_npx_adapter_moves_onto_latest() {
        assert_eq!(
            current_command("npx -y @agentclientprotocol/claude-agent-acp"),
            Some(CLAUDE_LATEST)
        );
        // Already on latest, a version the user chose, or not an npx adapter.
        assert_eq!(current_command(CLAUDE_LATEST), None);
        assert_eq!(
            current_command("npx -y @agentclientprotocol/claude-agent-acp@0.90.0"),
            None
        );
        assert_eq!(current_command("cursor-agent acp"), None);
    }

    #[test]
    fn is_npx_adapter_matches_the_package_at_any_version() {
        for command in [
            CLAUDE_LATEST,
            "npx -y @agentclientprotocol/claude-agent-acp@0.90.0",
            "npx -y @agentclientprotocol/claude-agent-acp@latest",
            // The bare scoped name: its only `@` is the scope.
            "npx -y @agentclientprotocol/claude-agent-acp",
            "npx -y @agentclientprotocol/codex-acp",
        ] {
            assert!(is_npx_adapter(command), "{command}");
        }
        for command in [
            "npx -y @agentclientprotocol/claude-agent",
            "npx my-acp-adapter",
            "cursor-agent acp",
        ] {
            assert!(!is_npx_adapter(command), "{command}");
        }
    }

    #[test]
    fn split_version_handles_a_multi_byte_space() {
        // A no-break space used to be sliced mid-character and panic.
        assert_eq!(
            split_version("npx\u{a0}pkg@1.0"),
            ("npx\u{a0}pkg", Some("1.0"))
        );
        assert_eq!(
            split_version("npx -y\u{3000}@scope/pkg"),
            ("npx -y\u{3000}@scope/pkg", None)
        );
    }

    #[test]
    fn install_hint_follows_the_package_at_any_version() {
        let hint = Some("npm i -g @agentclientprotocol/claude-agent-acp");
        assert_eq!(install_for(CLAUDE_LATEST), hint);
        assert_eq!(
            install_for("npx -y @agentclientprotocol/claude-agent-acp@0.90.0"),
            hint
        );
        assert_eq!(install_for("npx my-acp-adapter"), None);
    }

    #[test]
    fn catalogue_availability_is_a_path_lookup_with_no_launch() {
        // Readiness has to cost nothing: the card renders on open, and starting
        // a dozen agent processes to draw a dozen badges is not acceptable.
        assert!(!crate::terminal_agents::probe_available(
            "definitely-not-a-real-acp-adapter-xyz acp"
        ));
        for adapter in catalog() {
            assert_eq!(
                adapter.available,
                crate::terminal_agents::probe_available(&adapter.command),
                "{}",
                adapter.id
            );
        }
    }
}
