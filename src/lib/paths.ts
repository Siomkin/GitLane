// Small pure path/display helpers shared across file lists and the title bar.

/** Last path segment — the file or repo name. */
export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Directory portion with a trailing slash, or "" when the path has no dir. */
export function dirname(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}

/** Human-friendly repository label: the final path segment (either separator),
 * else `fallback`. */
export function repoLabel(path: string, fallback = "Repository"): string {
  return trimTrailingSeparators(path).split(/[/\\]/).pop() || fallback;
}

/** `owner/repo` from a forge web URL: scheme, host and a trailing `.git`
 * stripped. "" when the URL has no path. */
export function webUrlSlug(webUrl: string): string {
  return webUrl.replace(/^https?:\/\/[^/]+\/?/, "").replace(/\.git$/, "");
}

/** True for files the review surface can render as formatted Markdown. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * Drop trailing path separators (`/` or `\\`, any run) so two spellings of the
 * same directory compare equal, keeping a lone root. The one normalization for
 * path-keyed state — repo identity, tabs, worktree matching — and for watcher
 * routing and the watch/unwatch FIFO key (GL-125), so the two can never key
 * the same path differently. (Deeper canonicalization — `/tmp` vs
 * `/private/tmp` realpath — is orthogonal and out of scope.)
 */
export function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed === "" && path !== "" ? path[0] : trimmed;
}

/** Prefix of a repository on another machine (remote-ssh-repos):
 * `ssh://[user@]host[:port]/absolute/path`, used wherever a local path is. */
export const REMOTE_LOCATOR_PREFIX = "ssh://";

/** True when `path` names a repository opened over SSH. */
export function isRemoteLocator(path: string): boolean {
  return path.startsWith(REMOTE_LOCATOR_PREFIX);
}

/** `ssh://[user@]host[:port]` of a locator: what every repository on that host
 * shares, and the key its one session is tracked under. */
export function remoteOrigin(locator: string): string {
  const rest = locator.slice(REMOTE_LOCATOR_PREFIX.length);
  const slash = rest.indexOf("/");
  return REMOTE_LOCATOR_PREFIX + (slash === -1 ? rest : rest.slice(0, slash));
}

/** The host a locator names, as the user typed it (alias or `user@host`). */
export function remoteHost(locator: string): string {
  return remoteOrigin(locator).slice(REMOTE_LOCATOR_PREFIX.length).replace(/:\d+$/, "");
}

/** A path on `locator`'s host, as a locator on the same host. A path that is
 * already a locator (or has no host to join) is returned unchanged. */
export function withLocator(locator: string, serverPath: string): string {
  if (!isRemoteLocator(locator) || isRemoteLocator(serverPath)) return serverPath;
  return remoteOrigin(locator) + serverPath;
}
