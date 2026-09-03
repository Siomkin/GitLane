// Turn a classified command failure into something a person can act on. The
// *category* — hook rejection, auth, network, index lock, … — is decided in
// Rust next to the process that observed it and arrives as `CommandError.kind`
// / `code` (src-tauri/src/git/write/classify.rs); this module only formats
// copy from those fields. The regexes that remain are formatting, not
// classification: splitting a multi-remote fetch failure into per-remote
// blocks and picking each block's copy, stripping task-runner noise from a
// hook's reason lines, and extracting the host/user for the credential hint.
//
// A plain string (a legacy caller that stringified its error) carries no
// kind and is returned trimmed — pass the error object itself to keep the copy.

import type { ForgeAuthProvider } from "./api/providers";
import { ForgeKind } from "./api/git/types/repo";
import { toCommandError } from "./api/invoke";
import { forgeAuthProviderFor, providerForHost, type RemoteProvider } from "./remotes";

export interface FriendlyGitErrorOptions {
  /** Repo toasts point at Remote access; onboarding requests generic retry
   * wording because no repository settings surface exists yet. */
  credentialHelp?: "remoteAccess" | "generic";
}

// Package-manager / task-runner scaffolding lines that carry no actionable
// reason. Rust already strips these from a hook rejection's `message` — but
// when *every* line was noise it keeps the raw text, so the same filter runs
// here (a no-op on an already-filtered message) to fall back to the headline.
const NOISE =
  /^(?:yarn run\b|npm\b|pnpm\b|bun\b|> |\$ |info\b|warning\b|Done in\b|\[(?:STARTED|COMPLETED|SKIPPED|FAILED)\])/i;
const LINK = /Get help:|Visit https?:|yarnpkg\.com|conventional-changelog/i;
// The "husky - <hook> script failed" / "command failed" epilogue — the headline
// says this instead, so drop it from the reason lines.
const EPILOGUE =
  /husky\s*-\s*[\w-]+\s+(?:hook|script)\s+(?:failed|declined)|command failed with exit code/i;

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

const INDEX_LOCK_COPY =
  "Git couldn't update the index because a lock file exists. Another git process may still be running, or a previous operation left the lock behind.";

/** The transport sub-categories this module has copy for — the `code` Rust
 * attaches under `auth` / `network`. Other codes (`forbidden`, the forge CLI's
 * `notAuthenticated`, …) keep git's own text. */
type TransportCode =
  | "credentialsMissing"
  | "sshPublickey"
  | "sshHostKey"
  | "unreachable"
  | "notFoundOrDenied";

// Per-remote copy selection for a multi-remote failure ("bucket:\n…\nlab:\n…"):
// Rust classifies the whole output with one code, so each labelled block picks
// its own copy by shape. Formatting only — the category is already known.
const CREDENTIAL_PROMPT_DISABLED =
  /could not read (?:username|password).*terminal prompts disabled|terminal prompts disabled/i;
const SSH_AUTH_FAILURE = /permission denied \(publickey\)/i;
const SSH_HOST_KEY_FAILURE = /host key verification failed/i;
const REMOTE_UNREACHABLE =
  /^\s*(?:fatal:|ssh:|remote:\s*(?:error:\s*)?).*(?:could not resolve host|failed to connect|connection (?:timed out|refused)|network is unreachable|no route to host|ssl certificate problem|tls handshake|host key verification failed|unable to access .*?: (?:could not resolve host|failed to connect|connection (?:timed out|refused)|network is unreachable|no route to host|ssl certificate problem|tls handshake))/im;
const REMOTE_NOT_FOUND_OR_DENIED =
  /^\s*(?:fatal:|remote:\s*(?:error:\s*)?).*(?:project you were looking for could not be found|repository (?:'.*'\s*)?not found|could not read from remote repository|permission to view it)/im;

function transportCodeOf(body: string): TransportCode | null {
  if (CREDENTIAL_PROMPT_DISABLED.test(body)) return "credentialsMissing";
  if (SSH_AUTH_FAILURE.test(body)) return "sshPublickey";
  if (SSH_HOST_KEY_FAILURE.test(body)) return "sshHostKey";
  if (REMOTE_UNREACHABLE.test(body)) return "unreachable";
  if (REMOTE_NOT_FOUND_OR_DENIED.test(body)) return "notFoundOrDenied";
  return null;
}

/**
 * Which provider's Accounts connect view fixes an auth failure, from the host
 * embedded in its message (the HTTPS remote URL, or the `user@host:` prefix of
 * an SSH publickey refusal). `null` when no host is recognisable — the caller
 * falls back to the provider-less Accounts page. Routing over text, not a
 * category decision: the caller has already established `kind === "auth"`.
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
 * Format a command failure as friendly, readable copy. Hook rejections get a
 * headline naming the hook plus the hook's own reason lines; transport
 * failures get per-provider credential / SSH / network copy; a stranded index
 * lock gets neutral recovery copy. Every other kind — and any value that is
 * not a `CommandError` — comes back as its message, trimmed, so this is safe
 * to apply to every error toast.
 */
export function friendlyGitError(error: unknown, options: FriendlyGitErrorOptions = {}): string {
  const err = toCommandError(error);
  const text = err.message.replace(/\r\n/g, "\n").trim();
  if (!text) return "The git command failed without any output.";
  switch (err.kind) {
    case "auth":
    case "network":
      return friendlyTransportError(text, err.code ?? null, options) ?? text;
    case "indexLock":
      return INDEX_LOCK_COPY;
    case "hookRejected":
      return friendlyHookError(text, err.hook ?? null);
    default:
      return text;
  }
}

function friendlyHookError(text: string, hook: string | null): string {
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

function friendlyTransportError(
  text: string,
  code: string | null,
  options: FriendlyGitErrorOptions,
): string | null {
  const failures = remoteFailureBlocks(text)
    .map(({ remote, body }) => friendlyRemoteFailure(remote, transportCodeOf(body), body, options))
    .filter(Boolean) as string[];
  if (failures.length > 1) {
    return `Some remotes need attention:\n\n${dedupe(failures).join("\n")}`;
  }
  if (failures.length === 1) return failures[0];

  // Unlabelled output: the backend's code picks the copy; a code we have no
  // copy for (a 403, a forge CLI's own auth message) keeps git's text.
  return friendlyRemoteFailure(null, code ?? transportCodeOf(text), text, options);
}

function friendlyRemoteFailure(
  remote: string | null,
  code: string | null,
  body: string,
  options: FriendlyGitErrorOptions,
): string | null {
  const prefix = remote ? `${remote}: ` : "";
  switch (code) {
    case "credentialsMissing": {
      const identity = credentialIdentity(body);
      const provider = providerForHost(identity?.host ?? "");
      const name = CREDENTIAL_PROVIDER_NAME[provider];
      const account = identity?.username ? ` for @${identity.username}` : "";
      const providerHint = credentialHint(provider, options.credentialHelp ?? "remoteAccess");
      return `${prefix}${name} credentials are missing or invalid${account}. ${providerHint}`;
    }
    case "sshPublickey":
      return `${prefix}SSH authentication failed. Check that the correct SSH key is loaded and has access to this remote.`;
    case "sshHostKey":
      return `${prefix}SSH host verification failed. Verify the remote host key, then try again.`;
    case "unreachable":
      return `${prefix}Remote could not be reached. Check the remote URL, network connection, and host availability.`;
    case "notFoundOrDenied":
      return `${prefix}Remote repository not found or access denied. Check the remote URL and your account permissions.`;
    default:
      return null;
  }
}

// Split "name:\n<git output>" blocks (one per remote, as `fetch --all` emits)
// and keep those with recognisable transport copy. A leading "remote:" line
// that is git's own `remote:` echo (not a remote *named* remote) is skipped.
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

  return blocks.filter((block) => transportCodeOf(block.body) !== null);
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

// Credential-failure copy, keyed by the canonical `providerForHost`
// classification (remotes.ts) so a self-hosted forge named after its software
// (`gitlab.example.com`, `bitbucket.corp.test`) gets its provider's remediation
// instead of the generic Git helper copy. The `RemoteProvider` union makes both
// records exhaustive: a new forge cannot be added without deciding its copy.
const CREDENTIAL_PROVIDER_NAME: Record<RemoteProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure Repos",
  gitea: "Gitea",
  forgejo: "Forgejo",
  [ForgeKind.CursorOrigin]: "Cursor Origin",
  other: "Git",
};

const CREDENTIAL_HINT_STEM: Record<RemoteProvider, string> = {
  github: "Sign in with gh, pick a GitHub account, or use SSH",
  gitlab: "Sign in with glab, set up Git Credential Manager, or use SSH",
  bitbucket: "Set up Git Credential Manager or SSH",
  azure: "Set up Git Credential Manager or SSH",
  gitea: "Set up Git Credential Manager, a Git credential helper, or SSH",
  forgejo: "Set up Git Credential Manager, a Git credential helper, or SSH",
  [ForgeKind.CursorOrigin]: "Sign in with origin, or use SSH",
  other: "Set up Git Credential Manager, a Git credential helper, or SSH",
};

function credentialHint(provider: RemoteProvider, help: "remoteAccess" | "generic"): string {
  const suffix =
    help === "remoteAccess" ? " in Repository settings > Remote access, then try again." : ", then try again.";
  return `${CREDENTIAL_HINT_STEM[provider]}${suffix}`;
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}
