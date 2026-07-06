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

  it("rewrites terminal credential prompts into a Bitbucket setup hint", () => {
    const out = friendlyGitError(
      "bucket:\nfatal: could not read Password for 'https://SiomkinAlexander@bitbucket.org': terminal prompts disabled",
    );

    expect(out).toBe(
      "bucket: Bitbucket credentials are missing or invalid for @SiomkinAlexander. Save a Bitbucket API token or app password in Repository settings > Remote access, then try again.",
    );
  });

  it("rewrites an unlabeled credential failure", () => {
    expect(
      friendlyGitError(
        "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled",
      ),
    ).toBe(
      "GitLab credentials are missing or invalid. Save a GitLab access token in Repository settings > Remote access, then try again.",
    );
  });

  it("uses GitHub account-binding copy for GitHub credential failures", () => {
    expect(
      friendlyGitError(
        "origin:\nfatal: could not read Password for 'https://octocat@github.com': terminal prompts disabled",
      ),
    ).toBe(
      "origin: GitHub credentials are missing or invalid for @octocat. Sign in or pick a GitHub account in Repository settings > Remote access, then try again.",
    );
  });

  it("does not echo embedded passwords from credential URLs", () => {
    expect(
      friendlyGitError(
        "origin:\nfatal: could not read Password for 'https://octocat:secret@github.com': terminal prompts disabled",
      ),
    ).toBe(
      "origin: GitHub credentials are missing or invalid for @octocat. Sign in or pick a GitHub account in Repository settings > Remote access, then try again.",
    );
  });

  it("uses SSH-specific copy for publickey failures", () => {
    expect(
      friendlyGitError(
        "origin:\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      ),
    ).toBe(
      "origin: SSH authentication failed. Check that the correct SSH key is loaded and has access to this remote.",
    );
  });

  it("keeps the name for a remote literally called remote", () => {
    expect(
      friendlyGitError(
        "remote:\nfatal: could not read Password for 'https://alice@bitbucket.org': terminal prompts disabled",
      ),
    ).toBe(
      "remote: Bitbucket credentials are missing or invalid for @alice. Save a Bitbucket API token or app password in Repository settings > Remote access, then try again.",
    );
  });

  it("does not create a phantom remote for leading git remote output", () => {
    expect(
      friendlyGitError(
        "remote:\nremote: ERROR: The project you were looking for could not be found or you don't have permission to view it.",
      ),
    ).toBe(
      "Remote repository not found or access denied. Check the remote URL and your account permissions.",
    );
  });

  it("collapses multi-remote fetch failures into actionable lines", () => {
    const raw = [
      "bucket:",
      "fatal: could not read Password for 'https://SiomkinAlexander@bitbucket.org': terminal prompts disabled",
      "lab:",
      "remote:",
      "remote: ERROR: The project you were looking for could not be found or you don't have permission to view it.",
      "remote:",
      "fatal: Could not read from remote repository.",
      "",
      "Please make sure you have the correct access rights",
      "and the repository exists.",
    ].join("\n");

    expect(friendlyGitError(raw)).toBe(
      [
        "Some remotes need attention:",
        "",
        "bucket: Bitbucket credentials are missing or invalid for @SiomkinAlexander. Save a Bitbucket API token or app password in Repository settings > Remote access, then try again.",
        "lab: Remote repository not found or access denied. Check the remote URL and your account permissions.",
      ].join("\n"),
    );
  });

  it("separates network failures from permission failures", () => {
    expect(
      friendlyGitError("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"),
    ).toBe(
      "Remote could not be reached. Check the remote URL, network connection, and host availability.",
    );
  });

  it("separates SSH host verification from access-denied failures", () => {
    expect(
      friendlyGitError("Host key verification failed.\nfatal: Could not read from remote repository."),
    ).toBe("SSH host verification failed. Verify the remote host key, then try again.");
  });

  it("does not rewrite hook output just because it mentions a repository not found", () => {
    const raw = "husky - pre-push hook exited\nrepository not found in generated metadata";
    expect(friendlyGitError(raw)).toContain(
      "Your push was blocked by the repository’s “pre-push” Git hook:",
    );
  });

  it("handles empty output", () => {
    expect(friendlyGitError("")).toBe("The git command failed without any output.");
  });
});
