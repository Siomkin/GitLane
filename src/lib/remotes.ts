// Remote-URL parsing, provider detection, and add/edit validation for the
// Repository settings → Remotes panel. Pure functions (no React, no IPC) so the
// list chips, the summary card, and the add/edit forms all classify URLs the
// same way — ported from the Repo Settings design's `detect`/`cap`/`validity`.

import type { ForgeAuthProvider } from "./api/providers";
import type { GitTransportProvider } from "./api/git";
import { supportsPullRequests } from "./forgeHelp";

export type RemoteProvider =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "azure"
  | "gitea"
  | "forgejo"
  | "other";

export interface RemoteUrlInfo {
  /** No URL entered yet. */
  empty: boolean;
  /** Parses as a host + owner/repo path. */
  valid: boolean;
  host: string | null;
  /** Exact credential authority (`host[:port]`) Git passes to helpers. */
  credentialHost: string | null;
  path: string | null;
  /** The https URL's userinfo (`https://USER@host/…`) — git's native carrier
   * for "which account authenticates this remote" (gitcredentials(7): the
   * username is part of the credential context helpers resolve against).
   * `null` for SSH/scp URLs: their `git@` is the protocol user, and account
   * selection happens via SSH keys instead. */
  user: string | null;
  /** SSH-style URL (`ssh://` or scp `git@host:`): auth = SSH key. */
  ssh: boolean;
  provider: RemoteProvider;
}

export const providerForHost = (host: string): RemoteProvider => {
  // Mirrors the backend `forge::classify_host` (same order, same rules) so the
  // frontend and Rust agree on which forge a remote belongs to. GitHub detection
  // is exact (github.com / *.github.com) — a host that merely contains "github"
  // (e.g. github.corp.example GHE) isn't github.com, so it must not claim PR
  // support the toolbar would deny. Forgejo is checked before Gitea because
  // Codeberg (a Forgejo instance) has a bespoke host.
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("bitbucket")) return "bitbucket";
  if (host.includes("dev.azure") || host.includes("visualstudio")) return "azure";
  if (host === "codeberg.org" || host.includes("forgejo")) return "forgejo";
  if (host.includes("gitea")) return "gitea";
  return "other";
};

/** Map a remote's classified provider to the `ForgeAuthProvider` used by the
 * accounts/keychain surfaces, or `null` for providers that own auth another way
 * (GitHub via `gh`) or that can't be classified (`other`). Azure normalizes the
 * `"azure"` classification to the `"azure-devops"` provider key. */
export const forgeAuthProviderFor = (p: RemoteProvider): ForgeAuthProvider | null => {
  switch (p) {
    case "gitlab":
      return "gitlab";
    case "bitbucket":
      return "bitbucket";
    case "azure":
      return "azure-devops";
    case "gitea":
      return "gitea";
    case "forgejo":
      return "forgejo";
    default:
      return null;
  }
};

/** Map a classified remote provider to the provider tag used by git transport
 * auth refs. */
export const transportProviderForRemoteProvider = (p: RemoteProvider): GitTransportProvider => {
  switch (p) {
    case "azure":
      return "azure-devops";
    case "other":
      return "other";
    default:
      return p;
  }
};

/** The Azure DevOps organization from a remote path. Azure hosts many orgs on
 * one host (`dev.azure.com/{org}/…`, or the legacy `{org}.visualstudio.com`),
 * so credentials must scope by org — the git credential context needs the org
 * as its path (with `credential.useHttpPath=true`) or credentials collide across
 * orgs on `dev.azure.com`. Returns the org, or `null` when the URL isn't Azure
 * or the org can't be determined. */
export const azureOrg = (info: Pick<RemoteUrlInfo, "provider" | "host" | "path">): string | null => {
  if (info.provider !== "azure") return null;
  // Legacy `{org}.visualstudio.com`: the org is the leading host label.
  if (info.host && info.host.endsWith(".visualstudio.com")) {
    const org = info.host.slice(0, -".visualstudio.com".length);
    return org || null;
  }
  // `dev.azure.com/{org}/{project}/_git/{repo}`: the org is the first segment.
  const first = info.path?.split("/").filter(Boolean)[0];
  return first || null;
};

/** The credential-context path git should scope by for `info`, or `null` for the
 * host-only scope. Azure scopes by org (see {@link azureOrg}); every other
 * provider scopes by host alone, matching how their credential helpers behave. */
export const credentialScopePath = (info: RemoteUrlInfo): string | null =>
  info.provider === "azure" ? azureOrg(info) : null;

const hasCredentialProtocolSeparator = (value: string | null): boolean =>
  value !== null && /[\r\n\0]/.test(value);

/** Whether an HTTP(S) URL carries password-bearing userinfo. The final `@`
 * terminates userinfo so malformed inputs with an unescaped `@` in the password
 * are still rejected. Username-only selectors remain valid. */
export const httpUrlHasPassword = (raw: string): boolean => {
  const url = (raw ?? "").trim();
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return false;
  const scheme = url.slice(0, schemeEnd).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return false;
  const rest = url.slice(schemeEnd + 3);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = rest.slice(0, authorityEnd < 0 ? rest.length : authorityEnd);
  const at = authority.lastIndexOf("@");
  return at >= 0 && authority.slice(0, at).includes(":");
};

/** Parse an https or SSH/scp git remote URL into host + path + provider. */
export const detectRemoteUrl = (raw: string): RemoteUrlInfo => {
  const url = (raw ?? "").trim();
  const miss: RemoteUrlInfo = {
    empty: !url,
    valid: false,
    host: null,
    credentialHost: null,
    path: null,
    user: null,
    ssh: false,
    provider: "other",
  };
  if (!url) return miss;
  if (hasCredentialProtocolSeparator(url)) return miss;
  if (httpUrlHasPassword(url)) return miss;

  let host: string | null = null;
  let credentialHost: string | null = null;
  let path: string | null = null;
  let ssh = false;
  let m: RegExpMatchArray | null;
  if ((m = url.match(/^https?:\/\/([^/\s]+)\/(.+?)(?:\.git)?\/?$/i))) {
    [, host, path] = m;
  } else if ((m = url.match(/^ssh:\/\/(?:[^@/\s]+@)?(\[[^\]\s]+\]|[^:/\s]+)(?::(\d+))?\/(.+?)(?:\.git)?\/?$/i))) {
    const [, sshHost, sshPort, sshPath] = m;
    host = sshHost;
    credentialHost = sshPort ? `${sshHost}:${sshPort}` : sshHost;
    path = sshPath;
    ssh = true;
  } else if ((m = url.match(/^git@([^:/\s]+):(.+?)(?:\.git)?\/?$/i))) {
    [, host, path] = m;
    credentialHost = host;
    ssh = true;
  }
  // Require a host and at least an owner/repo (two path segments).
  if (!host || !path || path.split("/").filter(Boolean).length < 2) return miss;
  if (hasCredentialProtocolSeparator(host) || hasCredentialProtocolSeparator(path)) return miss;

  // Split off username-only https userinfo (https://user@host/…) — that's the
  // account selector git hands to credential helpers. A colon before the final
  // `@` is a password delimiter; reject that form so a token/password can never
  // be persisted in remote config or echoed across IPC. Preserve the host[:port]
  // authority for credential scoping while also exposing a portless display host
  // for provider classification.
  let user: string | null = null;
  if (!ssh && host.includes("@")) {
    const at = host.lastIndexOf("@");
    const rawUser = host.slice(0, at);
    try {
      user = decodeURIComponent(rawUser) || null;
    } catch {
      return miss;
    }
    host = host.slice(at + 1);
  }
  if (hasCredentialProtocolSeparator(user) || hasCredentialProtocolSeparator(host)) return miss;
  credentialHost = (credentialHost ?? host).toLowerCase();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close < 0) return miss;
    host = host.slice(1, close);
  } else {
    host = host.split(":")[0] || host;
  }
  host = host.replace(/^www\./, "").toLowerCase();
  return { empty: false, valid: true, host, credentialHost, path, user, ssh, provider: providerForHost(host) };
};

/** Rewrite an https remote URL's userinfo — the git-native way to pin which
 * account authenticates the remote (`https://LOGIN@host/…`); `null` removes
 * it (back to the default credential lookup). SSH/invalid URLs are returned
 * unchanged: their account is the SSH key, not a username. */
export const withUrlUser = (raw: string, user: string | null): string => {
  const url = (raw ?? "").trim();
  const m = url.match(/^(https?:\/\/)(?:[^/@]+@)?(.+)$/i);
  if (!m) return url;
  const [, scheme, rest] = m;
  return user ? `${scheme}${encodeURIComponent(user)}@${rest}` : `${scheme}${rest}`;
};

/** A user-friendly subset of git's remote-name rules: start with a letter or
 * digit, then letters/digits/`.`/`_`/`-` (no spaces or other punctuation). Keeps
 * obviously-bad names out of the add form before the git layer rejects them. */
export const isValidRemoteName = (raw: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.trim());

/** Forges with an in-app pull/merge-request surface (mirrors the toolbar provider
 * model): GitHub PRs, GitLab MRs (GL-140), and Bitbucket Cloud PRs (GL-141). */
export const providerSupportsPrs = (p: RemoteProvider): boolean =>
  supportsPullRequests(p);

/** The request noun a provider uses in copy — GitLab has "merge requests",
 * everyone else "pull requests" — so GitLab-facing text reads correctly (GL-145). */
export const prNoun = (p: RemoteProvider): string => (p === "gitlab" ? "merge requests" : "pull requests");
/** The short form of {@link prNoun} ("MR" / "PR"). */
export const prAbbr = (p: RemoteProvider): string => (p === "gitlab" ? "MR" : "PR");

const PROVIDER_LABEL: Record<RemoteProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
  gitea: "Gitea",
  forgejo: "Forgejo",
  other: "This host",
};

export const providerLabel = (p: RemoteProvider): string => PROVIDER_LABEL[p];

export type RemoteValidityLevel = "neutral" | "ok" | "warn" | "bad";

export interface RemoteValidity {
  level: RemoteValidityLevel;
  message: string;
  /** True when the URL is savable (valid), regardless of PR support. */
  ok: boolean;
}

/** Validate a remote URL for the add/edit forms: neutral (empty), bad (invalid),
 * ok (GitHub/GitLab/Bitbucket — PRs) or warn (valid other forge — no PRs, still
 * usable). */
export const validateRemoteUrl = (raw: string): RemoteValidity => {
  const d = detectRemoteUrl(raw);
  if (d.empty) return { level: "neutral", message: "Enter an https or SSH git URL.", ok: false };
  if (!d.valid) return { level: "bad", message: "Not a valid git remote URL.", ok: false };
  if (providerSupportsPrs(d.provider)) {
    return { level: "ok", message: `${providerLabel(d.provider)} · ${d.host} — ${prNoun(d.provider)} enabled`, ok: true };
  }
  return { level: "warn", message: `${d.host} — ${providerLabel(d.provider)} · pull requests unavailable`, ok: true };
};
