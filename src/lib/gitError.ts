// Turn a raw `git` write failure into something a person can act on. When a
// commit is rejected by a hook, git's error is the hook's *entire* stdout+stderr
// — for a husky/lint-staged/commitlint setup that's a wall of task-runner noise
// with the real reason buried a few lines in. This extracts the reason and names
// the hook. Ordinary (non-hook) git errors pass through unchanged.

// Signals that the failure came from a git hook rather than git itself.
const HOOK_HINT =
  /husky|\.husky\/|hook (?:failed|declined|denied)|\b(?:pre-commit|commit-msg|prepare-commit-msg|post-commit|pre-merge-commit|pre-push|pre-rebase)\b/i;

// Package-manager / task-runner scaffolding lines that carry no actionable reason.
const NOISE =
  /^(?:yarn run\b|npm\b|pnpm\b|bun\b|> |\$ |info\b|warning\b|Done in\b|\[(?:STARTED|COMPLETED|SKIPPED|FAILED)\])/i;
const LINK = /Get help:|Visit https?:|yarnpkg\.com|conventional-changelog/i;
// The "husky - <hook> script failed" / "command failed" epilogue — we say this in
// the headline instead, so drop it from the reason lines.
const EPILOGUE =
  /husky\s*-\s*[\w-]+\s+(?:hook|script)\s+(?:failed|declined)|command failed with exit code/i;

const HOOK_NAME =
  /husky\s*-\s*([\w-]+)\s+(?:hook|script)|\.husky\/([\w-]+)|\b(pre-commit|commit-msg|prepare-commit-msg|post-commit|pre-merge-commit|pre-push|pre-rebase)\b/i;

// What the user was trying to do, inferred from which hook fired.
const HOOK_ACTION: Record<string, string> = {
  "pre-commit": "commit",
  "commit-msg": "commit",
  "prepare-commit-msg": "commit",
  "post-commit": "commit",
  "pre-merge-commit": "merge",
  "pre-push": "push",
  "pre-rebase": "rebase",
};

/**
 * Rewrite a raw git/hook error into a friendly, readable message. Non-hook errors
 * are returned trimmed but otherwise unchanged, so this is safe to apply to every
 * error toast.
 */
export function friendlyGitError(raw: string): string {
  const text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "The git command failed without any output.";
  if (!HOOK_HINT.test(text)) return text; // an ordinary git error — show as-is

  const match = text.match(HOOK_NAME);
  const hook = match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;

  const reasons = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !NOISE.test(line) && !LINK.test(line) && !EPILOGUE.test(line));

  const action = hook ? (HOOK_ACTION[hook] ?? "change") : "change";
  const headline = hook
    ? `Your ${action} was blocked by the repository’s “${hook}” Git hook:`
    : "Your change was blocked by a Git hook:";

  return reasons.length ? `${headline}\n\n${reasons.join("\n")}` : headline;
}
