import { describe, it, expect } from "vitest";
import { CommandError, type CommandErrorPayload } from "@/lib/api";
import { authFailureProvider, friendlyGitError } from "./gitError";

// Fixtures are shaped the way Rust's classifier (src-tauri/src/git/write/
// classify.rs) produces them: the same raw git text, with the kind / code /
// hook it would attach. The expected user-facing strings are unchanged from
// the pre-`CommandError` formatter — that copy is the contract under test.

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

// What Rust sends for that blob: the reason lines only, the raw text in `detail`.
const commitlintRejection: CommandErrorPayload = {
  kind: "hookRejected",
  hook: "commit-msg",
  message: [
    "✖   input: Commit subject may not be empty [subject-empty]",
    "✖   type may not be empty [type-empty]",
    "✖   found 2 problems, 0 warnings",
  ].join("\n"),
  detail: commitlintBlob,
};

const auth = (code: string, message: string): CommandErrorPayload => ({ kind: "auth", code, message });
const network = (code: string, message: string): CommandErrorPayload => ({
  kind: "network",
  code,
  message,
});

describe("friendlyGitError — hook rejections", () => {
  it("names the hook and keeps only the real reason lines", () => {
    const out = friendlyGitError(commitlintRejection);
    expect(out).toContain("Your commit was blocked by the repository’s “commit-msg” Git hook:");
    expect(out).toContain("Commit subject may not be empty [subject-empty]");
    expect(out).toContain("type may not be empty [type-empty]");
  });

  it("never leaks the yarn / lint-staged / help noise held in detail", () => {
    const out = friendlyGitError(commitlintRejection);
    expect(out).not.toContain("yarn run");
    expect(out).not.toContain("lint-staged");
    expect(out).not.toContain("[COMPLETED]");
    expect(out).not.toContain("Done in");
    expect(out).not.toContain("Get help:");
    expect(out).not.toContain("Command failed with exit code");
    expect(out).not.toContain("husky - commit-msg script failed");
  });

  it("infers the action from the hook that fired", () => {
    const raw = "husky - pre-push hook exited\nrefusing to push";
    expect(
      friendlyGitError({ kind: "hookRejected", hook: "pre-push", message: raw, detail: raw }),
    ).toContain("Your push was blocked by the repository’s “pre-push” Git hook:");
  });

  it("falls back to a generic hook headline when the reason lines are all noise", () => {
    // Rust keeps the raw text as `message` when every line was scaffolding.
    const raw = "husky - pre-commit script failed (code 1)";
    expect(
      friendlyGitError({ kind: "hookRejected", hook: "pre-commit", message: raw, detail: raw }),
    ).toBe("Your commit was blocked by the repository’s “pre-commit” Git hook:");
  });

  it("uses the generic headline when no hook name was recognised", () => {
    expect(
      friendlyGitError({ kind: "hookRejected", message: "hook declined: branch is protected" }),
    ).toBe("Your change was blocked by a Git hook:\n\nhook declined: branch is protected");
  });

  it("does not rewrite hook output just because it mentions a repository not found", () => {
    const raw = "husky - pre-push hook exited\nrepository not found in generated metadata";
    expect(
      friendlyGitError({ kind: "hookRejected", hook: "pre-push", message: raw, detail: raw }),
    ).toContain("Your push was blocked by the repository’s “pre-push” Git hook:");
  });
});

describe("friendlyGitError — pass-through kinds", () => {
  it("leaves ordinary git errors untouched (aside from trimming)", () => {
    const raw = "error: pathspec 'nope' did not match any file(s) known to git";
    expect(friendlyGitError({ kind: "git", message: `  ${raw}  ` })).toBe(raw);
  });

  it("returns stale-lease, conflict, forge, and internal messages as-is", () => {
    const lease = "main changed from abc to def. Refresh and try again.";
    expect(friendlyGitError({ kind: "staleLease", message: lease })).toBe(lease);
    const conflict = "CONFLICT (content): Merge conflict in a.txt\r\nAutomatic merge failed";
    expect(friendlyGitError({ kind: "conflict", message: conflict })).toBe(
      "CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed",
    );
    expect(friendlyGitError({ kind: "forge", code: "rateLimited", message: "gh: rate limited" })).toBe(
      "gh: rate limited",
    );
    expect(friendlyGitError({ kind: "internal", code: "keychain", message: "keychain locked" })).toBe(
      "keychain locked",
    );
  });

  it("returns a plain string trimmed — a legacy caller lost the kind, so no copy is picked", () => {
    const raw = "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled";
    expect(friendlyGitError(`  ${raw}\r\n`)).toBe(raw);
  });

  it("returns an Error's message and an existing CommandError's copy", () => {
    expect(friendlyGitError(new Error("boom"))).toBe("boom");
    expect(
      friendlyGitError(new CommandError({ kind: "indexLock", message: "index.lock: File exists" })),
    ).toContain("lock file exists");
  });

  it("handles empty output", () => {
    expect(friendlyGitError({ kind: "git", message: "" })).toBe(
      "The git command failed without any output.",
    );
    expect(friendlyGitError("")).toBe("The git command failed without any output.");
  });
});

describe("friendlyGitError — transport auth / network copy", () => {
  it("rewrites terminal credential prompts into a Bitbucket setup hint", () => {
    const out = friendlyGitError(
      auth(
        "credentialsMissing",
        "bucket:\nfatal: could not read Password for 'https://test-user@bitbucket.org': terminal prompts disabled",
      ),
    );

    expect(out).toBe(
      "bucket: Bitbucket credentials are missing or invalid for @test-user. Set up Git Credential Manager or SSH in Repository settings > Remote access, then try again.",
    );
  });

  it("rewrites an unlabeled credential failure", () => {
    expect(
      friendlyGitError(
        auth(
          "credentialsMissing",
          "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled",
        ),
      ),
    ).toBe(
      "GitLab credentials are missing or invalid. Sign in with glab, set up Git Credential Manager, or use SSH in Repository settings > Remote access, then try again.",
    );
  });

  it("uses generic retry wording when asked (onboarding has no repo settings yet)", () => {
    expect(
      friendlyGitError(
        auth(
          "credentialsMissing",
          "fatal: could not read Password for 'https://test-user@bitbucket.org': terminal prompts disabled",
        ),
        { credentialHelp: "generic" },
      ),
    ).toBe(
      "Bitbucket credentials are missing or invalid for @test-user. Set up Git Credential Manager or SSH, then try again.",
    );
  });

  it("recognises self-hosted GitLab by its host label", () => {
    expect(
      friendlyGitError(
        auth(
          "credentialsMissing",
          "fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled",
        ),
      ),
    ).toBe(
      "GitLab credentials are missing or invalid. Sign in with glab, set up Git Credential Manager, or use SSH in Repository settings > Remote access, then try again.",
    );
  });

  it("recognises a self-hosted Bitbucket by its host label", () => {
    expect(
      friendlyGitError(
        auth(
          "credentialsMissing",
          "fatal: could not read Password for 'https://alice@bitbucket.corp.test': terminal prompts disabled",
        ),
      ),
    ).toBe(
      "Bitbucket credentials are missing or invalid for @alice. Set up Git Credential Manager or SSH in Repository settings > Remote access, then try again.",
    );
  });

  it("uses GitHub account-binding copy for GitHub credential failures", () => {
    expect(
      friendlyGitError(
        auth(
          "credentialsMissing",
          "origin:\nfatal: could not read Password for 'https://octocat@github.com': terminal prompts disabled",
        ),
      ),
    ).toBe(
      "origin: GitHub credentials are missing or invalid for @octocat. Sign in with gh, pick a GitHub account, or use SSH in Repository settings > Remote access, then try again.",
    );
  });

  it("does not echo the (already redacted) password segment of a credential URL", () => {
    expect(
      friendlyGitError(
        auth(
          "credentialsMissing",
          "origin:\nfatal: could not read Password for 'https://octocat:***@github.com': terminal prompts disabled",
        ),
      ),
    ).toBe(
      "origin: GitHub credentials are missing or invalid for @octocat. Sign in with gh, pick a GitHub account, or use SSH in Repository settings > Remote access, then try again.",
    );
  });

  it("uses SSH-specific copy for publickey failures", () => {
    expect(
      friendlyGitError(
        auth(
          "sshPublickey",
          "origin:\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        ),
      ),
    ).toBe(
      "origin: SSH authentication failed. Check that the correct SSH key is loaded and has access to this remote.",
    );
  });

  it("keeps the name for a remote literally called remote", () => {
    expect(
      friendlyGitError(
        auth(
          "credentialsMissing",
          "remote:\nfatal: could not read Password for 'https://alice@bitbucket.org': terminal prompts disabled",
        ),
      ),
    ).toBe(
      "remote: Bitbucket credentials are missing or invalid for @alice. Set up Git Credential Manager or SSH in Repository settings > Remote access, then try again.",
    );
  });

  it("does not create a phantom remote for leading git remote output", () => {
    expect(
      friendlyGitError(
        auth(
          "notFoundOrDenied",
          "remote:\nremote: ERROR: The project you were looking for could not be found or you don't have permission to view it.",
        ),
      ),
    ).toBe(
      "Remote repository not found or access denied. Check the remote URL and your account permissions.",
    );
  });

  it("collapses multi-remote fetch failures into actionable lines, one copy per block", () => {
    // Rust classifies the whole output once (credentials win); each labelled
    // remote block still picks its own copy by shape.
    const raw = [
      "bucket:",
      "fatal: could not read Password for 'https://test-user@bitbucket.org': terminal prompts disabled",
      "lab:",
      "remote:",
      "remote: ERROR: The project you were looking for could not be found or you don't have permission to view it.",
      "remote:",
      "fatal: Could not read from remote repository.",
      "",
      "Please make sure you have the correct access rights",
      "and the repository exists.",
    ].join("\n");

    expect(friendlyGitError(auth("credentialsMissing", raw))).toBe(
      [
        "Some remotes need attention:",
        "",
        "bucket: Bitbucket credentials are missing or invalid for @test-user. Set up Git Credential Manager or SSH in Repository settings > Remote access, then try again.",
        "lab: Remote repository not found or access denied. Check the remote URL and your account permissions.",
      ].join("\n"),
    );
  });

  it("separates network failures from permission failures", () => {
    expect(
      friendlyGitError(
        network(
          "unreachable",
          "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
        ),
      ),
    ).toBe("Remote could not be reached. Check the remote URL, network connection, and host availability.");
  });

  it("separates SSH host verification from access-denied failures", () => {
    expect(
      friendlyGitError(
        network("sshHostKey", "Host key verification failed.\nfatal: Could not read from remote repository."),
      ),
    ).toBe("SSH host verification failed. Verify the remote host key, then try again.");
  });

  it("picks copy from the backend code, not the text, for unlabeled output", () => {
    // The text would read as a credential prompt; the backend says publickey.
    expect(
      friendlyGitError(auth("sshPublickey", "fatal: terminal prompts disabled (see publickey)")),
    ).toBe("SSH authentication failed. Check that the correct SSH key is loaded and has access to this remote.");
  });

  it("keeps git's own text for a 403 and for forge-CLI auth codes", () => {
    const forbidden =
      "fatal: unable to access 'https://bitbucket.org/w/r.git/': The requested URL returned error: 403";
    expect(friendlyGitError(auth("forbidden", forbidden))).toBe(forbidden);
    expect(friendlyGitError(auth("notAuthenticated", "gh: not logged in to github.com"))).toBe(
      "gh: not logged in to github.com",
    );
    expect(friendlyGitError(network("transport", "tls: handshake timed out"))).toBe(
      "tls: handshake timed out",
    );
  });
});

describe("friendlyGitError — index lock", () => {
  it("rewrites a stranded index.lock failure into neutral recovery copy", () => {
    const out = friendlyGitError({
      kind: "indexLock",
      message: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    });
    expect(out).toContain("lock file exists");
    expect(out).not.toContain("No git process appears to be running");
  });

  it("does not rewrite a permission-denied index.lock create (a plain git failure)", () => {
    const raw = "fatal: Unable to create '/repo/.git/index.lock': Permission denied";
    expect(friendlyGitError({ kind: "git", message: raw })).toBe(raw);
  });
});

describe("authFailureProvider", () => {
  it("maps the failing HTTPS host to its provider key", () => {
    expect(
      authFailureProvider("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403"),
    ).toBe("github");
    expect(
      authFailureProvider(
        "fatal: could not read Password for 'https://ada@gitlab.com': terminal prompts disabled",
      ),
    ).toBe("gitlab");
    expect(
      authFailureProvider("fatal: unable to access 'https://bitbucket.org/w/r.git/': error: 403"),
    ).toBe("bitbucket");
  });

  it("reads the host off an SSH publickey refusal", () => {
    expect(
      authFailureProvider("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."),
    ).toBe("github");
  });

  it("returns null for unrecognisable hosts or hostless errors", () => {
    expect(authFailureProvider("fatal: Authentication failed")).toBeNull();
    expect(
      authFailureProvider("fatal: unable to access 'https://git.internal.corp/o/r.git/': error: 403"),
    ).toBeNull();
  });
});
