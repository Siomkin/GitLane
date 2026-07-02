import { describe, it, expect } from "vitest";
import { friendlyGitError } from "./gitError";

// The real output GitLane got back from a rejected squash commit (husky pre-commit
// lint-staged + commit-msg commitlint), newlines intact.
const commitlintBlob = [
  "yarn run v1.22.22",
  "$ /repo/node_modules/.bin/lint-staged",
  "[STARTED] Backing up original state...",
  "[COMPLETED] Backed up original state in git stash (9e1de43)",
  "[STARTED] Running tasks for staged files...",
  "[COMPLETED] Running tasks for staged files...",
  "[STARTED] Cleaning up temporary files...",
  "[COMPLETED] Cleaning up temporary files...",
  "Done in 1.90s.",
  "yarn run v1.22.22",
  "$ /repo/node_modules/.bin/commitlint --edit .git/COMMIT_EDITMSG",
  "✖   input: Commit subject may not be empty [subject-empty]",
  "✖   type may not be empty [type-empty]",
  "✖   found 2 problems, 0 warnings",
  "ⓘ   Get help: https://github.com/conventional-changelog/commitlint/#what-is-commitlint",
  "error Command failed with exit code 1.",
  "info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.",
  "husky - commit-msg script failed (code 1)",
].join("\n");

describe("friendlyGitError", () => {
  it("names the hook and keeps only the real reason lines", () => {
    const out = friendlyGitError(commitlintBlob);
    expect(out).toContain("Your commit was blocked by the repository’s “commit-msg” Git hook:");
    expect(out).toContain("Commit subject may not be empty [subject-empty]");
    expect(out).toContain("type may not be empty [type-empty]");
  });

  it("strips the yarn / lint-staged / help noise", () => {
    const out = friendlyGitError(commitlintBlob);
    expect(out).not.toContain("yarn run");
    expect(out).not.toContain("lint-staged");
    expect(out).not.toContain("[COMPLETED]");
    expect(out).not.toContain("Done in");
    expect(out).not.toContain("Get help:");
    expect(out).not.toContain("Command failed with exit code");
    expect(out).not.toContain("husky - commit-msg script failed");
  });

  it("infers the action from the hook that fired", () => {
    expect(friendlyGitError("husky - pre-push hook exited\nrefusing to push")).toContain(
      "Your push was blocked by the repository’s “pre-push” Git hook:",
    );
  });

  it("falls back to a generic hook headline when the reason lines are all noise", () => {
    expect(friendlyGitError("husky - pre-commit script failed (code 1)")).toBe(
      "Your commit was blocked by the repository’s “pre-commit” Git hook:",
    );
  });

  it("leaves ordinary git errors untouched (aside from trimming)", () => {
    const raw = "error: pathspec 'nope' did not match any file(s) known to git";
    expect(friendlyGitError(`  ${raw}  `)).toBe(raw);
  });

  it("handles empty output", () => {
    expect(friendlyGitError("")).toBe("The git command failed without any output.");
  });
});
