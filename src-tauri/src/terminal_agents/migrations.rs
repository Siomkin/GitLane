//! Load-time migrations: legacy shipped prompt texts, the Draft/Commit fold,
//! and the pre-list AI-action object shape.

use super::defaults::{
    ai_action_command, builtin_ai_action, AiActionCommand, BUILTIN_AI_ACTION_IDS,
    DEFAULT_AI_ACTION_FULL_TITLE, DEFAULT_AI_ACTION_IMPL_TITLE, DEFAULT_AI_ACTION_RELEASE_TITLE,
    DEFAULT_AI_ACTION_REVIEW_TITLE, DEFAULT_AI_ACTION_SHORT_TITLE, DEFAULT_AI_ACTION_TEST_TITLE,
    DEFAULT_DESCRIPTION_INSTRUCTION, DEFAULT_DRAFT_INSTRUCTION,
};

use super::messages::CommitAgentMessages;
use serde::{Deserialize, Deserializer};

/// Instructions GitLane used to ship. A saved config holding one of these
/// verbatim is an untouched old default, not a user preference, so it migrates
/// to the current text on load — otherwise every existing user keeps the old
/// prompt until they find "Reset" in Settings. Anything edited stays as the
/// user wrote it.
///
/// Add old shipped text here whenever a default changes. Exact matches migrate;
/// anything the user edited remains untouched.
pub(super) const LEGACY_INSTRUCTIONS: [&str; 21] = [
    "Review the staged changes and draft a concise conventional commit message.",
    "Review the staged changes, write a concise conventional-commit message, and commit them.",
    "Write a clear plain-text explanation of what the changes do and why they matter. Cover the main behavior, important implementation details, and notable effects or risks. Use as much detail as needed to make the changes understandable, while avoiding repetition or a file-by-file inventory.",
    "Read the staged diff once (`git diff --staged`) and write a conventional commit message. Do not open files, run tests, search the codebase, or review the code — be fast. Subject under 72 characters; add a short body only if the subject cannot carry it.",
    "Read the staged diff once (`git diff --staged`), write a conventional commit message, and commit. Do not open files, run tests, search the codebase, or review the code — be fast. Subject under 72 characters; add a short body only if the subject cannot carry it.",
    "Write an implementation summary in Markdown with these sections: `## Summary` (2-3 sentences), `## Changes` (bullets, each naming the file or module it touches), `## How to test` (numbered steps a reviewer can follow), and `## Risk` (one short paragraph). Reply with the Markdown and nothing else.",
    "Write one sentence saying what the change does. No preamble, no bullet list, no file inventory. Reply with the sentence and nothing else.",
    "Write a description of the change in at most three short paragraphs: what it does, how it works, and anything a reader would otherwise be surprised by. No headings, no file-by-file inventory. Reply with the description and nothing else.",
    "Write a Jira implementation comment for developers, PM, and QA. Reply with the comment and nothing else. Format for Jira's visual editor: bold section titles (not markdown # headings), plain dash bullets (never checkboxes), no fenced code blocks, inline code for paths and names. Omit any section that does not apply. Never pad. Start with a bold title (ticket key and short name when a key is named in this prompt). Then **What was done** (1-3 sentences: the problem and what the change did, readable by PM and QA). Then **Important changes** (bullets of user-visible or QA-relevant behavior, not implementation trivia). Include only when relevant: **Database**, **API / contracts**, **New files / classes**, **Tests** (what was added and whether they ran), **QA checklist** (2-5 grouped scenarios such as Happy path, Validation, Regression, with exact UI paths, actions, and expected results — no vague 'test that it works'), **Needs attention** (real risks only), **Future refactoring / tech debt**.",
    "Write the release-note entries for this change as Markdown bullets, one per user-visible change, each phrased for someone who uses the app and has not read the code. Omit internal refactors that change nothing a user can see. Reply with the bullets and nothing else.",
    "List what a reviewer should look at closely: correctness risks, missed cases, and anything the change leaves inconsistent. Be specific — name the file and what could go wrong. Say plainly when a part looks low risk. Reply with the findings and nothing else.",
    "Write a numbered manual test plan for this change: the steps to run, and what to expect at each one. Cover the main path and the edge cases the change introduces. Reply with the plan and nothing else.",
    "Summarize the change in one sentence, focusing on what changed and why it matters. No preamble, bullets, or file inventory. Reply with the sentence and nothing else.",
    "Read the staged diff once (`git diff --staged`) and write a conventional commit message. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything. Reply with the commit message and nothing else.",
    "Read the staged diff once (`git diff --staged`), write a conventional commit message, and commit. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything.",
    "Write a concise summary of what changed and why it matters. Include enough detail to understand the main behavior and important effects; use a short paragraph or a few bullets when that is clearer. No preamble or file-by-file inventory. Reply with the summary and nothing else.",
    "Write a clear description of what changed, why it was needed, and how the main pieces work together. Include user-visible behavior, important implementation choices, and relevant limitations or trade-offs when supported by the diff. Use enough detail to make the change understandable without turning it into a file-by-file inventory. Reply with the description and nothing else.",
    "Write a practical implementation update for developers, product, and QA. Explain the problem, the solution, and any behavior or contract impact. Include validation evidence, QA actions with expected results, real risks, and follow-ups only when relevant. Use short sections or bullets when they help, omit empty sections and file-by-file inventories, and do not claim tests ran unless the evidence says so. Reply with the update and nothing else.",
    "Write release-note entries for people who use the product. Explain every meaningful user-visible outcome and why it is useful in plain language, without implementation details. Omit refactors, tests, and other internal-only work. If there is no user-visible change, say so plainly. Reply with the release notes and nothing else.",
    "Review the diff for concrete defects that could break behavior, lose data, weaken security, or cause regressions. Report only actionable findings supported by the diff, highest impact first. For each finding, name the affected area, explain the failure scenario, and suggest the smallest fix. Skip summaries, praise, style preferences, speculative concerns, and low-risk observations. Reply with the findings and nothing else; if there are none, reply exactly: No actionable findings.",
    "Write a focused numbered manual test plan for the behavior affected by this change. Cover the main path plus edge cases and regressions that are relevant to the diff, not generic checks. Each step must say what to do and what result to expect. Include setup only when needed, and do not invent UI paths, data, or prerequisites. Reply with the plan and nothing else.",
];

pub(super) fn default_description_instruction() -> String {
    DEFAULT_DESCRIPTION_INSTRUCTION.into()
}

pub(super) fn migrate_legacy_instruction(saved: &mut String, current_default: &str) {
    if LEGACY_INSTRUCTIONS.contains(&saved.as_str()) {
        *saved = current_default.into();
    }
}

/// Draft and Commit were separate prompts; they are now one editable field.
/// Fold them here, at load, rather than letting a save quietly overwrite one
/// with the other: a user who only ever customized the commit prompt would
/// otherwise lose that text the first time they toggled an AI action.
///
/// The customized text wins. When both were customized the draft prompt wins,
/// because that is the one the Prompts panel now shows and edits.
pub(super) fn merge_draft_and_commit_instructions(messages: &mut CommitAgentMessages) {
    if messages.commit_instruction == messages.draft_instruction {
        return;
    }
    if messages.draft_instruction == DEFAULT_DRAFT_INSTRUCTION {
        messages.draft_instruction = messages.commit_instruction.clone();
    }
    messages.commit_instruction = messages.draft_instruction.clone();
}

/// The six-string object shipped before AI actions became a list.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAiActionInstructions {
    short: String,
    full: String,
    #[serde(rename = "impl")]
    implementation: String,
    release: String,
    review: String,
    test: String,
}

impl LegacyAiActionInstructions {
    fn into_commands(self) -> Vec<AiActionCommand> {
        vec![
            ai_action_command("short", DEFAULT_AI_ACTION_SHORT_TITLE, &self.short),
            ai_action_command("full", DEFAULT_AI_ACTION_FULL_TITLE, &self.full),
            ai_action_command("impl", DEFAULT_AI_ACTION_IMPL_TITLE, &self.implementation),
            ai_action_command("release", DEFAULT_AI_ACTION_RELEASE_TITLE, &self.release),
            ai_action_command("review", DEFAULT_AI_ACTION_REVIEW_TITLE, &self.review),
            ai_action_command("test", DEFAULT_AI_ACTION_TEST_TITLE, &self.test),
        ]
    }
}

pub(super) fn deserialize_ai_actions<'de, D>(
    deserializer: D,
) -> Result<Vec<AiActionCommand>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        List(Vec<AiActionCommand>),
        Legacy(LegacyAiActionInstructions),
    }
    Ok(match Raw::deserialize(deserializer)? {
        Raw::List(list) => list,
        Raw::Legacy(legacy) => legacy.into_commands(),
    })
}

pub(super) fn migrate_ai_action_commands(saved: &mut Vec<AiActionCommand>) {
    for command in saved.iter_mut() {
        if let Some(builtin) = builtin_ai_action(&command.id) {
            migrate_legacy_instruction(&mut command.instruction, &builtin.instruction);
        }
    }
    let missing: Vec<&str> = BUILTIN_AI_ACTION_IDS
        .into_iter()
        .filter(|id| saved.iter().all(|command| command.id != *id))
        .collect();
    for id in missing {
        if let Some(command) = builtin_ai_action(id) {
            saved.push(command);
        }
    }
}
