// Turn a raw `git` write failure into something a person can act on. When a
// commit is rejected by a hook, git's error is the hook's *entire* stdout+stderr
// — for a husky/lint-staged/commitlint setup that's a wall of task-runner noise
// with the real reason buried a few lines in. This extracts the reason and names
// the hook. Ordinary (non-hook) git errors pass through unchanged.

import type { ForgeAuthProvider } from "./api/providers";
import { forgeAuthProviderFor, providerForHost } from "./remotes";

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

const CREDENTIAL_PROMPT_DISABLED =
  /could not read (?:username|password).*terminal prompts disabled|terminal prompts disabled/i;
const SSH_AUTH_FAILURE = /permission denied \(publickey\)/i;
const SSH_HOST_KEY_FAILURE = /host key verification failed/i;
const REMOTE_UNREACHABLE =
  /^\s*(?:fatal:|ssh:|remote:\s*(?:error:\s*)?).*(?:could not resolve host|failed to connect|connection (?:timed out|refused)|network is unreachable|no route to host|ssl certificate problem|tls handshake|host key verification failed|unable to access .*?: (?:could not resolve host|failed to connect|connection (?:timed out|refused)|network is unreachable|no route to host|ssl certificate problem|tls handshake))/im;
const REMOTE_NOT_FOUND_OR_DENIED =
  /^\s*(?:fatal:|remote:\s*(?:error:\s*)?).*(?:project you were looking for could not be found|repository (?:'.*'\s*)?not found|could not read from remote repository|permission to view it)/im;

/** True when a git failure is the stranded-/contended-`.git/index.lock` shape (GL-335).
 * Requires contention evidence (`File exists` / “another git process…”) so a
 * permission-denied “Unable to create …/index.lock” is not treated as stranded. */
export function classifyIndexLockFailure(raw: string): boolean {
  const text = (raw ?? "").replace(/\r\n/g, "\n").toLowerCase();
  if (!text.includes("index.lock")) return false;
  return (
    text.includes("file exists") ||
    text.includes("could not write index") ||
    text.includes("another git process seems to be running")
  );
}

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

// 403 = reached-but-refused: the credential was accepted but lacks permission.
// Checked separately from REMOTE_NOT_FOUND_OR_DENIED because git prefixes
// "unable to access" onto the same line.
const HTTP_FORBIDDEN = /error:? 403|403 forbidden/i;

/**
 * Classify a git transport failure as an authentication problem the user can fix
 * by providing/repairing a credential — or `null` for everything else (conflicts,
 * hooks, plain network unreachability…). Drives "Fix authentication…" actions.
 * `REMOTE_NOT_FOUND_OR_DENIED` is deliberately included even though it also
 * matches a typo'd URL: forges hide private repos behind "not found", so an
 * unauthenticated clone/fetch of a private repo produces exactly this shape.
 */
export function classifyGitAuthFailure(raw: string): { kind: "credentials" | "ssh" | "denied" } | null {
  const text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  if (SSH_AUTH_FAILURE.test(text)) return { kind: "ssh" };
  if (HTTP_FORBIDDEN.test(text)) return { kind: "denied" };
  if (CREDENTIAL_PROMPT_DISABLED.test(text)) return { kind: "credentials" };
  if (REMOTE_NOT_FOUND_OR_DENIED.test(text)) return { kind: "denied" };
  return null;
}

/**
 * Which provider's Accounts connect view fixes this auth failure, from the host
 * embedded in the error (the HTTPS remote URL, or the `user@host:` prefix of an
 * SSH publickey refusal). `null` when no host is recognisable — the caller
 * falls back to the provider-less Accounts page.
 */
export function authFailureProvider(raw: string): "github" | ForgeAuthProvider | null {
  const text = (raw ?? "").replace(/\r\n/g, "\n");
  const host =
    credentialIdentity(text)?.host ??
    text.match(/(?:^|\n)\s*(?:[\w.-]+@)?([\w.-]+\.[\w-]+): permission denied/i)?.[1]?.toLowerCase() ??
    null;
  if (!host) return null;
  const provider = providerForHost(host);
  return provider === "github" ? "github" : forgeAuthProviderFor(provider);
}

/**
 * Rewrite a raw git/hook error into a friendly, readable message. Non-hook errors
 * are returned trimmed but otherwise unchanged, so this is safe to apply to every
 * error toast. Repo toasts can point at Remote access; onboarding can request
 * generic retry wording because no repository settings surface exists yet.
 */
export function friendlyGitError(
  raw: string,
  options: { credentialHelp?: "remoteAccess" | "generic" } = {},
): string {
  const text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "The git command failed without any output.";
  const network = friendlyNetworkGitError(text, options);
  if (network) return network;
  if (classifyIndexLockFailure(text)) {
    return "Git couldn't update the index because a lock file exists. Another git process may still be running, or a previous operation left the lock behind.";
  }
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

function friendlyNetworkGitError(
  text: string,
  options: { credentialHelp?: "remoteAccess" | "generic" },
): string | null {
  if (
    !CREDENTIAL_PROMPT_DISABLED.test(text) &&
    !SSH_AUTH_FAILURE.test(text) &&
    !SSH_HOST_KEY_FAILURE.test(text) &&
    !REMOTE_UNREACHABLE.test(text) &&
    !REMOTE_NOT_FOUND_OR_DENIED.test(text)
  ) {
    return null;
  }

  const failures = remoteFailureBlocks(text)
    .map(({ remote, body }) => friendlyRemoteFailure(remote, body, options))
    .filter(Boolean) as string[];
  if (failures.length > 1) {
    return `Some remotes need attention:\n\n${dedupe(failures).join("\n")}`;
  }
  if (failures.length === 1) return failures[0];

  return friendlyRemoteFailure(null, text, options);
}

function friendlyRemoteFailure(
  remote: string | null,
  body: string,
  options: { credentialHelp?: "remoteAccess" | "generic" },
): string | null {
  const prefix = remote ? `${remote}: ` : "";
  if (CREDENTIAL_PROMPT_DISABLED.test(body)) {
    const identity = credentialIdentity(body);
    const provider = providerName(identity?.host);
    const account = identity?.username ? ` for @${identity.username}` : "";
    const providerHint = credentialHint(provider, options.credentialHelp ?? "remoteAccess");
    return `${prefix}${provider} credentials are missing or invalid${account}. ${providerHint}`;
  }

  if (SSH_AUTH_FAILURE.test(body)) {
    return `${prefix}SSH authentication failed. Check that the correct SSH key is loaded and has access to this remote.`;
  }

  if (SSH_HOST_KEY_FAILURE.test(body)) {
    return `${prefix}SSH host verification failed. Verify the remote host key, then try again.`;
  }

  if (REMOTE_UNREACHABLE.test(body)) {
    return `${prefix}Remote could not be reached. Check the remote URL, network connection, and host availability.`;
  }

  if (REMOTE_NOT_FOUND_OR_DENIED.test(body)) {
    return `${prefix}Remote repository not found or access denied. Check the remote URL and your account permissions.`;
  }

  return null;
}

function remoteFailureBlocks(text: string): Array<{ remote: string; body: string }> {
  const blocks: Array<{ remote: string; body: string }> = [];
  let current: { remote: string; lines: string[] } | null = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const label = trimmed.match(/^([A-Za-z0-9._-]+):$/);
    if (label && !(current && label[1] === "remote")) {
      if (label[1] === "remote" && !current && lines[i + 1]?.trim().startsWith("remote:")) {
        continue;
      }
      if (current) blocks.push({ remote: current.remote, body: current.lines.join("\n") });
      current = { remote: label[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push({ remote: current.remote, body: current.lines.join("\n") });

  return blocks.filter(
    (block) =>
      CREDENTIAL_PROMPT_DISABLED.test(block.body) ||
      SSH_AUTH_FAILURE.test(block.body) ||
      SSH_HOST_KEY_FAILURE.test(block.body) ||
      REMOTE_UNREACHABLE.test(block.body) ||
      REMOTE_NOT_FOUND_OR_DENIED.test(block.body),
  );
}

function credentialIdentity(text: string): { username: string | null; host: string | null } | null {
  const match = text.match(/https?:\/\/([^@\s'"]+)@([^/'"\s:]+)(?::\d+)?/i);
  if (match)
    return { username: decodeURIComponentSafe(match[1].split(":")[0]), host: match[2].toLowerCase() };
  const hostOnly = text.match(/https?:\/\/([^/'"\s:]+)(?::\d+)?/i);
  if (!hostOnly) return null;
  return { username: null, host: hostOnly[1].toLowerCase() };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function providerName(host: string | null | undefined): string {
  if (!host) return "Git";
  if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) return "Bitbucket";
  if (host === "github.com" || host.endsWith(".github.com")) return "GitHub";
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "GitLab";
  if (
    host === "dev.azure.com" ||
    host.endsWith(".dev.azure.com") ||
    host === "visualstudio.com" ||
    host.endsWith(".visualstudio.com")
  )
    return "Azure Repos";
  return "Git";
}

function credentialHint(provider: string, help: "remoteAccess" | "generic"): string {
  const suffix =
    help === "remoteAccess" ? " in Repository settings > Remote access, then try again." : ", then try again.";
  if (provider === "Bitbucket") return `Set up Git Credential Manager or SSH${suffix}`;
  if (provider === "GitHub") return `Sign in with gh, pick a GitHub account, or use SSH${suffix}`;
  if (provider === "GitLab") return `Sign in with glab, set up Git Credential Manager, or use SSH${suffix}`;
  if (provider === "Azure Repos") return `Set up Git Credential Manager or SSH${suffix}`;
  return `Set up Git Credential Manager, a Git credential helper, or SSH${suffix}`;
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}
