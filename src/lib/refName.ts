// Pure, client-side branch-name validation mirroring `git check-ref-format
// --branch` (GL-120 P2-7). This is a *pre-flight* guard so the create/rename
// dialogs reject an obviously-bad name before shelling out to git — git itself
// remains the source of truth and will still reject anything this misses. Kept
// pure (no React, no IPC) so it's trivially testable.

/**
 * Validate a proposed branch (short) name against git's ref-format rules.
 * Returns a human-readable error message when invalid, or `null` when the name
 * is acceptable.
 *
 * The rules encoded here are the branch-relevant subset of `git help
 * check-ref-format`:
 *  - not empty;
 *  - no ASCII control chars, space, or any of `~ ^ : ? * [ \`;
 *  - no `..`, no `@{`, and the name is not a lone `@`;
 *  - no leading `-` (would read as a git option), no leading/trailing `/`,
 *    no `//`, no trailing `.`;
 *  - no path component that starts with `.` or ends with `.lock`.
 */
export function validateBranchName(name: string): string | null {
  const value = name.trim();
  if (!value) return "Enter a branch name.";

  if (value.startsWith("-")) return "A branch name can't start with “-”.";
  if (value.startsWith("/") || value.endsWith("/"))
    return "A branch name can't start or end with “/”.";
  if (value.endsWith("."))
    return "A branch name can't end with “.”.";
  if (value.includes("//"))
    return "A branch name can't contain “//”.";
  if (value.includes(".."))
    return "A branch name can't contain “..”.";
  if (value.includes("@{"))
    return "A branch name can't contain “@{”.";
  if (value === "@") return "A branch name can't be a single “@”.";

  // Control chars (incl. DEL), space, and git's reserved punctuation.
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "A branch name can't contain control characters.";
    if (ch === " ") return "A branch name can't contain spaces.";
    if ("~^:?*[\\".includes(ch)) return `A branch name can't contain “${ch}”.`;
  }

  // Per-component rules (a name like `feature/x` has components `feature`, `x`).
  for (const part of value.split("/")) {
    if (part.startsWith("."))
      return "No part of a branch name can start with “.”.";
    if (part.endsWith(".lock"))
      return "No part of a branch name can end with “.lock”.";
  }

  return null;
}
