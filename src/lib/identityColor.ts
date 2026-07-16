// Stable per-identity colour. Keyed on the person's email so the same person
// gets the same badge colour everywhere in the app — the graph node, the node
// hover card, the commit-detail author block, and the trailer People rows.
// Mirrors the "Author on the dot" design prototype's palette and hash.

export const IDENTITY_COLORS = [
  "#3b7ff5", // blue
  "#2e9e62", // green
  "#7a5af0", // purple
  "#e0843b", // orange
  "#0e9b8a", // teal
  "#db4d8a", // pink
  "#d64545", // red
  "#4f46e5", // indigo
] as const;

/** A user's saved colour overrides, keyed by lower-cased email. */
export type IdentityColorOverrides = Record<string, string>;

/** Deterministic colour for an identity key (an email, usually). Falls back to
 * the name when a commit has no email. Case- and whitespace-insensitive so
 * `Jane@Example.com` and `jane@example.com ` stay one person. When `overrides`
 * is supplied, a user-chosen colour for that email wins over the hash. */
export function identityColor(key: string, overrides?: IdentityColorOverrides): string {
  const normalized = key.trim().toLowerCase();
  const override = overrides?.[normalized];
  if (override) return override;
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return IDENTITY_COLORS[hash % IDENTITY_COLORS.length];
}
