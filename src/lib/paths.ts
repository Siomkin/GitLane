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

/** Human-friendly repository label: the final path segment. */
export function repoLabel(path: string): string {
  return path.replace(/\/$/, "").split("/").pop() || "Repository";
}

/** True for files the review surface can render as formatted Markdown. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * Normalize an open-repository path so the same repo routes and sequences
 * identically regardless of a trailing-separator difference (GL-125). Used both
 * for `repo-changed` event routing (`useRepoWatcher`) and for keying the
 * watch/unwatch FIFO queue + the backend watch key (`repoWatchQueue`), so the
 * ordering guarantee can't be bypassed by a `/foo` vs `/foo/` mismatch. The
 * watch key, `summary.path`, and `openPaths` entries all derive from the same
 * `open_repo` result today, so exact equality already matches — this only guards
 * against a future divergent representation, which would otherwise silently drop
 * a tab's events or split it across two chains/backend keys. (Deeper
 * canonicalization — `/tmp` vs `/private/tmp` realpath — is orthogonal and out
 * of scope.)
 */
export function normalizeWatchPath(path: string): string {
  // Preserve a lone "/" (filesystem root); only trim a trailing separator
  // otherwise.
  return path.length > 1 && (path.endsWith("/") || path.endsWith("\\"))
    ? path.slice(0, -1)
    : path;
}
