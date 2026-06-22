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
