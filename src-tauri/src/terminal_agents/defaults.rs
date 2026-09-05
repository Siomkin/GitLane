//! Shipped defaults: prompt texts, picker titles, and the built-in AI-action
//! list they compose into.

use super::agents::default_enabled;
use serde::{Deserialize, Serialize};

// Draft / Improve (ACP) and Commit with agent (terminal) share this. The
// call site adds the mode: ACP asks for the message only; the terminal path
// asks the agent to commit. "Add a body … unless the change is small"
// replaced "add a short body only if the subject cannot carry it", which had
// agents answering with a bare subject even for large diffs.
pub const DEFAULT_DRAFT_INSTRUCTION: &str =
    "Read the staged diff once (`git diff --staged`) and write a conventional commit message. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything.";
pub const DEFAULT_COMMIT_INSTRUCTION: &str = DEFAULT_DRAFT_INSTRUCTION;
pub const DEFAULT_DESCRIPTION_INSTRUCTION: &str =
    "Summarize what the changes do and why, in at most 4 sentences or 5 short bullets. Read the diff only — do not open other files, run tests, or search the codebase. This is a quick summary, not a code review: no quality findings, no risk analysis, no file-by-file inventory. Be fast.";
pub const DEFAULT_AI_ACTION_SHORT: &str =
    "Write a concise summary of what changed and why it matters, in at most 4 sentences or 5 short bullets. Use Markdown — a short paragraph, or a bullet list when that is clearer. Include enough detail to understand the main behavior and important effects. No preamble or file-by-file inventory. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_FULL: &str =
    "Write a clear Markdown description of what changed, why it was needed, and how the main pieces work together. Use short headings and bullets where they help scanning. Include user-visible behavior, important implementation choices, and relevant limitations or trade-offs when supported by the diff. Use enough detail to make the change understandable without turning it into a file-by-file inventory. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_IMPL: &str =
    "Write a practical implementation update for developers, product, and QA as Markdown. Use short headings and bullets. Explain the problem, the solution, and any behavior or contract impact. Include validation evidence, QA actions with expected results, real risks, and follow-ups only when relevant. Omit empty sections and file-by-file inventories, and do not claim tests ran unless the evidence says so. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_RELEASE: &str =
    "Write release-note entries for people who use the product as Markdown bullets. Explain every meaningful user-visible outcome and why it is useful in plain language, without implementation details. Omit refactors, tests, and other internal-only work. If there is no user-visible change, say so plainly. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_REVIEW: &str =
    "Review the diff for concrete defects that could break behavior, lose data, weaken security, or cause regressions. Report only actionable findings supported by the diff, highest impact first, as a Markdown list. For each finding, name the affected area, explain the failure scenario, and suggest the smallest fix. Skip summaries, praise, style preferences, speculative concerns, and low-risk observations. Reply with the Markdown and nothing else; if there are none, reply exactly: No actionable findings.";
pub const DEFAULT_AI_ACTION_TEST: &str =
    "Write a focused numbered Markdown test plan for the behavior affected by this change. Cover the main path plus edge cases and regressions that are relevant to the diff, not generic checks. Each step must say what to do and what result to expect. Include setup only when needed, and do not invent UI paths, data, or prerequisites. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_SHORT_TITLE: &str = "Short description";
pub const DEFAULT_AI_ACTION_FULL_TITLE: &str = "Full description";
pub const DEFAULT_AI_ACTION_IMPL_TITLE: &str = "Implementation comment";
pub const DEFAULT_AI_ACTION_RELEASE_TITLE: &str = "Release notes";
pub const DEFAULT_AI_ACTION_REVIEW_TITLE: &str = "Review & risk";
pub const DEFAULT_AI_ACTION_TEST_TITLE: &str = "Test plan";

pub(super) const BUILTIN_AI_ACTION_IDS: [&str; 6] =
    ["short", "full", "impl", "release", "review", "test"];

/// One AI-actions popup command: a picker label plus the prompt sent to the
/// agent. Builtins use stable ids (`short`, `full`, …); user-added rows use a
/// uuid. Disabled rows stay in the config but hide from the picker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiActionCommand {
    pub id: String,
    pub title: String,
    pub instruction: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

pub(super) fn ai_action_command(id: &str, title: &str, instruction: &str) -> AiActionCommand {
    AiActionCommand {
        id: id.into(),
        title: title.into(),
        instruction: instruction.into(),
        enabled: true,
    }
}

pub(super) fn builtin_ai_action(id: &str) -> Option<AiActionCommand> {
    match id {
        "short" => Some(ai_action_command(
            "short",
            DEFAULT_AI_ACTION_SHORT_TITLE,
            DEFAULT_AI_ACTION_SHORT,
        )),
        "full" => Some(ai_action_command(
            "full",
            DEFAULT_AI_ACTION_FULL_TITLE,
            DEFAULT_AI_ACTION_FULL,
        )),
        "impl" => Some(ai_action_command(
            "impl",
            DEFAULT_AI_ACTION_IMPL_TITLE,
            DEFAULT_AI_ACTION_IMPL,
        )),
        "release" => Some(ai_action_command(
            "release",
            DEFAULT_AI_ACTION_RELEASE_TITLE,
            DEFAULT_AI_ACTION_RELEASE,
        )),
        "review" => Some(ai_action_command(
            "review",
            DEFAULT_AI_ACTION_REVIEW_TITLE,
            DEFAULT_AI_ACTION_REVIEW,
        )),
        "test" => Some(ai_action_command(
            "test",
            DEFAULT_AI_ACTION_TEST_TITLE,
            DEFAULT_AI_ACTION_TEST,
        )),
        _ => None,
    }
}

pub(super) fn default_ai_actions() -> Vec<AiActionCommand> {
    BUILTIN_AI_ACTION_IDS
        .iter()
        .filter_map(|id| builtin_ai_action(id))
        .collect()
}
