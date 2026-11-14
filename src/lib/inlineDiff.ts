// A diff attached to an agent prompt. Without it the agent spends tool turns
// running `git diff` / `git show` and reading back long output (trimmed by its
// own plugins), which made a commit-message draft take most of a minute.

/** Largest diff inlined into a prompt (~50k tokens). Above it the agent reads
 * the diff itself, as it did before diffs were inlined. */
export const INLINE_DIFF_MAX_BYTES = 200_000;

/** `prompt` with `patch` appended inside `<tag>`, or unchanged when there is no
 * patch (over the cap, or unreadable). `commands` names what not to re-run. */
export function withInlineDiff(prompt: string, patch: string | null, tag: string, commands: string): string {
  if (!patch?.trim()) return prompt;
  return `${prompt}\n\nThe complete ${tag.replace("-", " ")} is below, so there is no need to run ${commands}.\n\n<${tag}>\n${patch}</${tag}>`;
}
