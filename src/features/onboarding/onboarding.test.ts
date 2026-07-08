import { describe, expect, it } from "vitest";
import {
  avatarFor,
  canceledCloneCopy,
  classifyCloneError,
  isSafeLeafName,
  joinPath,
  parentDir,
  parseRepoName,
  relativeTime,
  retryRerunsClone,
  validateCloneUrl,
} from "./onboarding";

describe("validateCloneUrl", () => {
  it("accepts the common Git URL forms and extracts the repo name", () => {
    for (const url of [
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo",
      "git@github.com:owner/repo.git",
      "ssh://git@host:22/owner/repo.git",
      "git://host/owner/repo.git",
    ]) {
      expect(validateCloneUrl(url).state, url).toBe("valid");
    }
    expect(validateCloneUrl("https://github.com/owner/repo.git").repo).toBe("repo");
    expect(validateCloneUrl("git@github.com:acme/design-system.git").repo).toBe("design-system");
  });

  it("flags empty vs malformed input distinctly", () => {
    expect(validateCloneUrl("").state).toBe("empty");
    expect(validateCloneUrl("   ").state).toBe("empty");
    expect(validateCloneUrl("not a url").state).toBe("invalid");
    expect(validateCloneUrl("ftp://example.com/x").state).toBe("invalid");
  });

  it("rejects URLs whose derived folder name would escape the parent", () => {
    // Otherwise-wellformed URLs whose leaf is a dot-segment must not be cloneable.
    expect(validateCloneUrl("https://github.com/owner/.").state).toBe("invalid");
    expect(validateCloneUrl("https://github.com/owner/..").state).toBe("invalid");
  });
});

describe("isSafeLeafName", () => {
  it("accepts ordinary folder names", () => {
    for (const ok of ["repo", "my-project", "repo.git", "a.b.c"]) {
      expect(isSafeLeafName(ok), ok).toBe(true);
    }
  });

  it("rejects empty, dot-segments, and separators", () => {
    for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "./x"]) {
      expect(isSafeLeafName(bad), bad).toBe(false);
    }
  });
});

describe("parseRepoName", () => {
  it("strips .git and trailing slashes", () => {
    expect(parseRepoName("https://github.com/owner/repo.git/")).toBe("repo");
    expect(parseRepoName("https://github.com/owner/repo")).toBe("repo");
    expect(parseRepoName("")).toBe("repository");
  });
});

describe("classifyCloneError", () => {
  it("maps an existing destination", () => {
    const c = classifyCloneError(
      "fatal: destination path 'core' already exists and is not an empty directory.",
    );
    expect(c.kind).toBe("exists");
    expect(c.fail).toBe(true);
    expect(c.cmd).toContain("already exists");
    expect(c.retryLabel).toBe("Choose another folder");
  });

  it("maps authentication failures", () => {
    expect(classifyCloneError("fatal: Authentication failed for 'https://x/y.git'").kind).toBe(
      "auth",
    );
    expect(classifyCloneError("remote: Permission denied (publickey).").kind).toBe("auth");
  });

  it("maps git's bare SSH access failure to a recoverable auth error", () => {
    // Sometimes the ONLY stderr line for a missing/rejected key — it must land
    // on the recovery screen, not the generic "Clone failed" dead end.
    const bare = classifyCloneError("fatal: Could not read from remote repository.");
    expect(bare.kind).toBe("auth");
    expect(bare.recoverable).toBe(true);

    const hostKey = classifyCloneError(
      "Host key verification failed.\nfatal: Could not read from remote repository.",
    );
    expect(hostKey.kind).toBe("auth");
    expect(hostKey.recoverable).toBe(true);
  });

  it("does not route a local filesystem permission error to auth recovery", () => {
    // git uses "Permission denied" for a destination it can't write, too — that
    // is not an auth problem, so it must not open the token-entry panel.
    const fs = classifyCloneError(
      "fatal: could not create work tree dir 'repo': Permission denied",
    );
    expect(fs.kind).toBe("failed");
    expect(fs.recoverable).toBe(false);
  });

  it("keeps an HTTPS not-found as an unreachable (edit-URL) error, not auth", () => {
    // A typo'd/private HTTPS repo surfaces as "not found" (no SSH read line), so
    // the retry returns to the form to fix the URL rather than asking for a token.
    const c = classifyCloneError(
      "remote: Repository not found.\nfatal: repository 'https://github.com/octo/nope.git/' not found",
    );
    expect(c.kind).toBe("unreachable");
    expect(c.recoverable).toBe(false);
  });

  it("reuses friendly git auth copy for credential and SSH failures", () => {
    const bitbucket = classifyCloneError(
      "fatal: could not read Password for 'https://SiomkinAlexander@bitbucket.org': terminal prompts disabled",
    );
    expect(bitbucket.message).toBe(
      "Bitbucket credentials are missing or invalid for @SiomkinAlexander. Save a Bitbucket API token or app password, then try again.",
    );

    const ssh = classifyCloneError(
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    );
    expect(ssh.message).toBe(
      "SSH authentication failed. Check that the correct SSH key is loaded and has access to this remote.",
    );
  });

  it("maps unreachable / not-found remotes", () => {
    expect(classifyCloneError("fatal: repository 'https://x/y.git' not found").kind).toBe(
      "unreachable",
    );
    expect(classifyCloneError("fatal: could not resolve host: example.invalid").kind).toBe(
      "unreachable",
    );
  });

  it("maps a 403 to access-denied, not unreachable (reached but refused)", () => {
    const c = classifyCloneError(
      "fatal: unable to access 'https://bitbucket.org/darang/repo.git/': The requested URL returned error: 403",
    );
    expect(c.kind).toBe("denied");
    expect(c.title).toMatch(/denied/i);
    // Bitbucket-specific hint since the URL is bitbucket; the username
    // convention itself lives in the recovery panel, not the headline.
    expect(c.message).toMatch(/Atlassian API token/);
    // The recovery panel fixes the credential in place, so retry reruns the clone.
    expect(c.recoverable).toBe(true);
    expect(retryRerunsClone(c.kind)).toBe(true);
  });

  it("surfaces the server's own remote: explanation on a 403", () => {
    const c = classifyCloneError(
      "remote: API Token provided has no Bitbucket scopes.\n" +
        "fatal: unable to access 'https://bitbucket.org/w/r.git/': The requested URL returned error: 403",
    );
    expect(c.kind).toBe("denied");
    expect(c.message).toContain("API Token provided has no Bitbucket scopes.");
  });

  it("reuses friendly git copy for unreachable clone failures", () => {
    const c = classifyCloneError(
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
    );
    expect(c.kind).toBe("unreachable");
    expect(c.message).toBe(
      "Remote could not be reached. Check the remote URL, network connection, and host availability.",
    );
  });

  it("maps a concurrent-clone rejection", () => {
    const c = classifyCloneError("A clone is already in progress.");
    expect(c.kind).toBe("failed");
    expect(c.title).toBe("A clone is already running");
    expect(c.cmd).toBe("");
  });

  it("falls back to a generic failure with the message preserved", () => {
    const c = classifyCloneError("fatal: something unexpected happened");
    expect(c.kind).toBe("failed");
    expect(c.cmd).toBe("fatal: something unexpected happened");
  });

  it("extracts the fatal line for the terminal block", () => {
    const c = classifyCloneError("Cloning into 'x'...\nremote: counting\nfatal: not found\n");
    expect(c.cmd).toBe("fatal: not found");
  });
});

describe("canceled + retry semantics", () => {
  it("cancel is a neutral (non-fail) state", () => {
    const c = canceledCloneCopy();
    expect(c.kind).toBe("canceled");
    expect(c.fail).toBe(false);
    expect(c.cmd).toBe("");
  });

  it("retry re-runs for auth/canceled/failed, returns to the form otherwise", () => {
    expect(retryRerunsClone("auth")).toBe(true);
    expect(retryRerunsClone("denied")).toBe(true);
    expect(retryRerunsClone("canceled")).toBe(true);
    expect(retryRerunsClone("failed")).toBe(true);
    expect(retryRerunsClone("exists")).toBe(false);
    expect(retryRerunsClone("unreachable")).toBe(false);
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  it("renders compact buckets", () => {
    expect(relativeTime(0, now)).toBe("");
    expect(relativeTime(now - 30_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 days ago");
    expect(relativeTime(now - 10 * 86_400_000, now)).toBe("last week");
    expect(relativeTime(now - 45 * 86_400_000, now)).toBe("last month");
  });
});

describe("avatarFor", () => {
  it("derives up to two initials and a stable hue", () => {
    expect(avatarFor("gitlane-core").initials).toBe("GC");
    expect(avatarFor("infra").initials).toBe("IN");
    expect(avatarFor("design-system").initials).toBe("DS");
    expect(avatarFor("repo").hue).toBe(avatarFor("repo").hue);
  });
});

describe("path math", () => {
  it("parentDir / joinPath round-trip", () => {
    expect(parentDir("/Users/me/code/repo")).toBe("/Users/me/code");
    expect(parentDir("/Users/me/code/repo/")).toBe("/Users/me/code");
    expect(parentDir("repo")).toBe("");
    expect(joinPath("/Users/me/code", "repo")).toBe("/Users/me/code/repo");
    expect(joinPath("/Users/me/code/", "repo")).toBe("/Users/me/code/repo");
    expect(joinPath("", "repo")).toBe("repo");
  });
});
