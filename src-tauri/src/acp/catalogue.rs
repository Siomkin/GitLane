//! The shipped adapter catalogue — the ACP agents GitLane offers, and
//! whether each one's launcher is on PATH.

use super::AcpAdapter;

/// ACP agents GitLane knows how to launch. Listing one is not a promise that it
/// is installed — `available` answers that on sight, and a failed launch says
/// why — so the catalogue can be generous. Anything absent still works as a
/// custom adapter, since the command is free text.
///
/// Six were handshaked against the real CLI on a dev machine (the five below
/// plus GitHub Copilot). Kiro and Junie carry commands from their vendors' own
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
            available: crate::terminal_agents::probe(command),
        })
        .collect()
}

/// The install command the catalogue knows for `command`, if any — what a
/// launch failure should tell the user to run instead of a generic example.
/// A pure table lookup: no PATH probing, since the caller already knows the
/// launch failed.
pub(super) fn install_for(command: &str) -> Option<&'static str> {
    let command = command.trim();
    ENTRIES
        .iter()
        .find(|(_, _, entry, _, _, _)| *entry == command)
        .map(|(_, _, _, install, _, _)| *install)
        .filter(|install| !install.is_empty())
}

// (id, name, command, install, docs, requires)
const ENTRIES: [(&str, &str, &str, &str, &str, &str); 15] = [
    (
        "claude",
        "Claude Code",
        "npx -y @agentclientprotocol/claude-agent-acp",
        "npm i -g @agentclientprotocol/claude-agent-acp",
        "https://docs.claude.com/en/docs/claude-code/overview",
        "The `claude` CLI, signed in. A Pro/Max subscription drives it with no API key.",
    ),
    (
        "codex",
        "Codex",
        "npx -y @agentclientprotocol/codex-acp",
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
                "npx -y @agentclientprotocol/claude-agent-acp",
                "npx -y @agentclientprotocol/codex-acp",
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

    #[test]
    fn catalogue_availability_is_a_path_lookup_with_no_launch() {
        // Readiness has to cost nothing: the card renders on open, and starting
        // a dozen agent processes to draw a dozen badges is not acceptable.
        assert!(!crate::terminal_agents::probe(
            "definitely-not-a-real-acp-adapter-xyz acp"
        ));
        for adapter in catalog() {
            assert_eq!(
                adapter.available,
                crate::terminal_agents::probe(&adapter.command),
                "{}",
                adapter.id
            );
        }
    }
}
