// Turn a classified command failure into something a person can act on. The
// *category* — hook rejection, auth, network, index lock, … — is decided in
// Rust next to the process that observed it and arrives as `CommandError.kind`
// / `code` (src-tauri/src/git/write/classify.rs); this module only formats
// copy from those fields. The regexes that remain are formatting, not
// classification: splitting a multi-remote fetch failure into its per-remote
// blocks (each remote's code arrives in `remoteFailures`), stripping
// task-runner noise from a hook's reason lines, and extracting the host/user
// for the credential hint.
//
// A plain string (a legacy caller that stringified its error) carries no
// kind and is returned trimmed — pass the error object itself to keep the copy.

import type { ForgeAuthProvider } from "./api/providers";
import { ForgeKind } from "./api/git/types/repo";
import { toCommandError } from "./api/invoke";
import type { RemoteFailure } from "./api/git/types/error";
import { forgeAuthProviderFor, providerForHost, type RemoteProvider } from "./remotes";

export interface FriendlyGitErrorOptions {
  /** Repo toasts point at Remote access; onboarding requests generic retry
   * wording because no repository settings surface exists yet. */
  credentialHelp?: "remoteAccess" | "generic";
  /** The SSH host a repository opened over SSH lives on: git ran there, with
   * that server's credentials, so this computer's accounts can't fix it. */
  serverHost?: string;
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
      return friendlyTransportError(text, err.code ?? null, err.remoteFailures ?? [], options) ?? text;
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
  remoteFailures: RemoteFailure[],
  options: FriendlyGitErrorOptions,
): string | null {
  // A multi-remote fetch: Rust classified each failed remote's own output, so
  // each labelled block gets the copy for its remote's code.
  const bodies = remoteBlocks(text);
  const failures = remoteFailures
    .map(({ remote, code }) => friendlyRemoteFailure(remote, code ?? null, bodies.get(remote) ?? "", options))
    .filter(Boolean) as string[];
  if (failures.length > 1) {
    return `Some remotes need attention:\n\n${dedupe(failures).join("\n")}`;
  }
  if (failures.length === 1) return failures[0];

  // Unlabelled output: the backend's code picks the copy; a code we have no
  // copy for (a forge CLI's own auth message) keeps git's text.
  return friendlyRemoteFailure(null, code, text, options);
}

function friendlyRemoteFailure(
  remote: string | null,
  code: string | null,
  body: string,
  options: FriendlyGitErrorOptions,
): string | null {
  const prefix = remote ? `${remote}: ` : "";
  const server = options.serverHost;
  switch (code) {
    case "credentialsMissing": {
      if (server) {
        const identity = credentialIdentity(body);
        const name = CREDENTIAL_PROVIDER_NAME[providerForHost(identity?.host ?? "")];
        const account = identity?.username ? ` for @${identity.username}` : "";
        return `${prefix}${server} has no ${name} login git can use${account}. ${serverLoginFix(server, identity?.host)}`;
      }
      const identity = credentialIdentity(body);
      const provider = providerForHost(identity?.host ?? "");
      const name = CREDENTIAL_PROVIDER_NAME[provider];
      const account = identity?.username ? ` for @${identity.username}` : "";
      const providerHint = credentialHint(provider, options.credentialHelp ?? "remoteAccess");
      const reached = provider === "other" ? "the server" : name;
      return `${prefix}Git found no saved ${name} credential${account}, so none reached ${reached}. ${providerHint}`;
    }
    case "credentialsRejected": {
      const identity = credentialIdentity(body);
      const provider = providerForHost(identity?.host ?? "");
      const name = CREDENTIAL_PROVIDER_NAME[provider];
      const account = identity?.username ? ` for @${identity.username}` : "";
      if (server) {
        return `${prefix}${provider === "other" ? "The remote" : name} rejected the credential git on ${server} sent${account}. It may be expired or revoked. ${serverLoginFix(server, identity?.host)}`;
      }
      if (provider !== "github") {
        return `${prefix}${provider === "other" ? "The server" : name} rejected the saved credential${account}. It may be expired, revoked or mistyped; save a new one, then try again.`;
      }
      const slug = repositorySlug(body);
      const owner = slug ? ` For ${slug} the resource owner must be ${slug.split("/")[0]}.` : "";
      return `${prefix}GitHub rejected the saved token${account}. It may be expired, revoked, or a fine-grained token limited to another owner's repositories.${owner}`;
    }
    case "forbidden":
      return server
        ? `${prefix}The remote accepted the credential git on ${server} sent, but refused this operation. Give that account write access to this repository, or sign in on ${server} as one that has it.`
        : forbiddenCopy(prefix, body);
    case "sshPublickey":
      return server
        ? `${prefix}SSH authentication from ${server} failed. Check that ${server} has an SSH key with access to this remote.`
        : `${prefix}SSH authentication failed. Check that the correct SSH key is loaded and has access to this remote.`;
    case "sshHostKey":
      return server
        ? `${prefix}Git on ${server} doesn't trust the remote's SSH host key yet. In the terminal on ${server}, connect to that host once with \`ssh -T\` (for example \`ssh -T git@github.com\`), check the key and accept it, then try again.`
        : `${prefix}SSH host verification failed. Verify the remote host key, then try again.`;
    case "unreachable":
      return `${prefix}Remote could not be reached. Check the remote URL, network connection, and host availability.`;
    case "notFoundOrDenied":
      return `${prefix}Remote repository not found or access denied. Check the remote URL and your account permissions.`;
    default:
      return null;
  }
}

// Split "name:\n<git output>" blocks (one per remote, as fetch labels them)
// into each remote's body. A leading "remote:" line that is git's own
// `remote:` echo (not a remote *named* remote) is skipped.
function remoteBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
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
      if (current) blocks.set(current.remote, current.lines.join("\n"));
      current = { remote: label[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.set(current.remote, current.lines.join("\n"));

  return blocks;
}

function credentialIdentity(text: string): { username: string | null; host: string | null } | null {
  // Git quotes the remote URL it failed on ('https://host'); prefer that over a
  // helper's own notice printed before it (GCM links aka.ms, for one).
  const quoted = text.match(/'(https?:\/\/[^'\s]+)'/i);
  if (quoted && quoted[1] !== text) {
    const identity = credentialIdentity(quoted[1]);
    if (identity) return identity;
  }
  const match = text.match(/https?:\/\/([^@\s'"]+)@([^/'"\s:]+)(?::\d+)?/i);
  if (match) {
    const username = decodeURIComponentSafe(match[1].split(":")[0]);
    // A token pasted as the URL's username must never be echoed as a login.
    return { username: /^(?:ghp_|github_pat_|gho_|ghu_|ghs_|glpat-)/i.test(username) ? null : username, host: match[2].toLowerCase() };
  }
  const hostOnly = text.match(/https?:\/\/([^/'"\s:]+)(?::\d+)?/i);
  if (!hostOnly) return null;
  return { username: null, host: hostOnly[1].toLowerCase() };
}

/** `owner/repo` from the first HTTPS remote URL in git's output. */
function repositorySlug(text: string): string | null {
  const match = text.match(/https?:\/\/[^/'"\s]+\/([^/'"\s]+)\/([^/'"\s]+?)(?:\.git)?\/?(?=['"\s]|$)/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

const TOKEN_PERMISSION_FIX =
  "For a fine-grained token, set Contents: Read and write, with a resource owner and repository access that include the repository; for a classic token, add the repo scope. A GitHub CLI account needs write access to the repository.";

/**
 * A 403 / `Permission to <repo> denied to <login>`: the credential worked but
 * lacks permission. GitHub prints the repo and login; SSH is told apart from
 * HTTPS by the missing `https://` URL (only SSH prints "Could not read from
 * remote repository"). Built from git's names only, never from a URL's
 * userinfo, so a token in the output cannot reach the copy.
 */
function forbiddenCopy(prefix: string, body: string): string {
  const denied = body.match(/permission to ([\w.-]+\/[\w.-]+?)(?:\.git)? denied to ([\w-]+)/i);
  const https = credentialIdentity(body);
  const ssh = !https && (!!denied || /could not read from remote repository/i.test(body));
  const github = ssh ? !!denied : providerForHost(https?.host ?? "") === "github";
  if (!github) {
    return `${prefix}The server accepted the credential but refused this operation. Check that your account or token has write access to this repository.`;
  }
  const repo = denied?.[1] ?? repositorySlug(body);
  const target = repo ? `push to ${repo}` : "do this on this repository";
  if (ssh) {
    const who = denied ? ` as @${denied[2]}` : "";
    return `${prefix}Your SSH key signed in to GitHub${who}, but it may not ${target}. The account this key belongs to needs write access; a deploy key needs "Allow write access" on GitHub.`;
  }
  const who = denied ? ` as @${denied[2]}` : "";
  return `${prefix}Your credential signed in to GitHub${who}, but it may not ${target}. ${TOKEN_PERMISSION_FIX}`;
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
/** What to run on a repository's SSH server so its git can authenticate to
 * `host`: the forge CLI's login where one serves git credentials, else a
 * credential helper or an SSH remote URL (remote/ssh-repos). */
function serverLoginCommand(host: string | null | undefined): string | null {
  if (!host) return null;
  const provider = providerForHost(host);
  if (provider === "github") return `gh auth login --hostname ${host}`;
  if (provider === "gitlab") return `glab auth login --hostname ${host}`;
  return null;
}

function serverLoginFix(server: string, host: string | null | undefined): string {
  const command = serverLoginCommand(host);
  return command
    ? `In the terminal on ${server}, run \`${command}\`, set up a git credential helper there, or switch the remote to an SSH URL. Then try again.`
    : `On ${server}, set up a git credential helper or switch the remote to an SSH URL. Then try again.`;
}

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
  github:
    "Save a personal access token as a GitLane token (it doesn't depend on your credential helper), sign in with gh, or use SSH",
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
