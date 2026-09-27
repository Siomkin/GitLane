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
