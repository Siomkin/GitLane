// Git profiles — reusable, named commit identities (name + email + optional
// signing) that apply to any repo, independent of provider accounts. This is
// the pure data layer: the `GitProfile` shape, the draft used by the editor,
// and the selection logic that maps a repo's *current* local identity back onto
// a saved profile. No React, no zustand, no IPC — so the matching rules are
// unit-testable in isolation (see profiles.test.ts).

import type { RepoIdentity } from "./api";

/** A saved, reusable git identity. Signing fields hold only a *reference* (GPG
 * key id or SSH key path/literal) — never a passphrase or private key. */
export interface GitProfile {
  id: string;
  label: string;
  name: string;
  email: string;
  signingKey?: string;
  gpgFormat?: "openpgp" | "ssh";
  gpgSign?: boolean;
  color: string;
  /** The profile suggested for repos with nothing pinned (the starred one). */
  isDefault?: boolean;
}

/** Editor payload for create/update — everything a `GitProfile` has except the
 * generated `id`/`color` (kept stable across edits by the store). */
export interface ProfileDraft {
  id?: string;
  label: string;
  name: string;
  email: string;
  signingKey?: string;
  gpgFormat?: "openpgp" | "ssh";
  gpgSign?: boolean;
}

/** Which option in the Identity panel reflects the repo's current local config.
 * - `default` — nothing pinned locally; the repo uses the global git identity.
 * - `profile` — a saved profile is applied; `customEmail` is true when the repo
 *   overrides that profile's email with a hand-edited one.
 * - `unmanaged` — a local identity is pinned that matches no saved profile. */
export type ProfileSelection =
  | { kind: "default" }
  | { kind: "profile"; id: string; customEmail: boolean }
  | { kind: "unmanaged" };

/** Resolve which profile (if any) the repo's pinned identity corresponds to.
 * An exact name+email hit is the profile with no override; a name-only hit means
 * the email was customised for this repo. `null` identity → the default option. */
export function selectProfile(
  repoIdentity: RepoIdentity | null,
  profiles: GitProfile[],
): ProfileSelection {
  if (!repoIdentity) return { kind: "default" };
  const exact = profiles.find(
    (p) => p.name === repoIdentity.name && p.email === repoIdentity.email,
  );
  if (exact) return { kind: "profile", id: exact.id, customEmail: false };
  const byName = profiles.find((p) => p.name === repoIdentity.name);
  if (byName) return { kind: "profile", id: byName.id, customEmail: true };
  return { kind: "unmanaged" };
}

/** Two-letter avatar initials for a profile (from its label). */
export function profileInitials(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "··";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}
