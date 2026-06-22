// Pure presentation helpers for the commit metadata block (CommitInspector).

/** 1–2 letter avatar initials from an author's display name. Splits on any
 * whitespace, drops empties, takes the first letter of the first two words,
 * uppercased. Returns "" for an empty/blank name. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}
