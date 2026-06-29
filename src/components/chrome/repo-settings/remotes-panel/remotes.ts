// Remote-URL parsing, provider detection, and add/edit validation for the
// Repository settings → Remotes panel. Pure functions (no React, no IPC) so the
// list chips, the summary card, and the add/edit forms all classify URLs the
// same way — ported from the Repo Settings design's `detect`/`cap`/`validity`.

export type RemoteProvider = "github" | "gitlab" | "bitbucket" | "azure" | "other";

export interface RemoteUrlInfo {
  /** No URL entered yet. */
  empty: boolean;
  /** Parses as a host + owner/repo path. */
  valid: boolean;
  host: string | null;
  path: string | null;
  provider: RemoteProvider;
}

const providerForHost = (host: string): RemoteProvider => {
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("bitbucket")) return "bitbucket";
  if (host.includes("dev.azure") || host.includes("visualstudio")) return "azure";
  return "other";
};

/** Parse an https or SSH/scp git remote URL into host + path + provider. */
export const detectRemoteUrl = (raw: string): RemoteUrlInfo => {
  const url = (raw ?? "").trim();
  const miss: RemoteUrlInfo = { empty: !url, valid: false, host: null, path: null, provider: "other" };
  if (!url) return miss;

  let host: string | null = null;
  let path: string | null = null;
  let m: RegExpMatchArray | null;
  if ((m = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i))) {
    [, host, path] = m;
  } else if ((m = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/i))) {
    [, host, path] = m;
  }
  // Require a host and at least an owner/repo (two path segments).
  if (!host || !path || path.split("/").filter(Boolean).length < 2) return miss;

  host = host.replace(/^www\./, "").toLowerCase();
  return { empty: false, valid: true, host, path, provider: providerForHost(host) };
};

/** A user-friendly subset of git's remote-name rules: start with a letter or
 * digit, then letters/digits/`.`/`_`/`-` (no spaces or other punctuation). Keeps
 * obviously-bad names out of the add form before the git layer rejects them. */
export const isValidRemoteName = (raw: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.trim());

/** Only GitHub exposes pull requests today (mirrors the toolbar provider model). */
export const providerSupportsPrs = (p: RemoteProvider): boolean => p === "github";

const PROVIDER_LABEL: Record<RemoteProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
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
 * ok (GitHub — PRs), or warn (valid non-GitHub — no PRs, still usable). */
export const validateRemoteUrl = (raw: string): RemoteValidity => {
  const d = detectRemoteUrl(raw);
  if (d.empty) return { level: "neutral", message: "Enter an https or SSH git URL.", ok: false };
  if (!d.valid) return { level: "bad", message: "Not a valid git remote URL.", ok: false };
  if (providerSupportsPrs(d.provider)) {
    return { level: "ok", message: `GitHub · ${d.host} — pull requests enabled`, ok: true };
  }
  return { level: "warn", message: `${d.host} — ${providerLabel(d.provider)} · pull requests unavailable`, ok: true };
};
