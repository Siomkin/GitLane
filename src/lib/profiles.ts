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
  tagGpgSign?: boolean;
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
  tagGpgSign?: boolean;
}

/** Which option in the Identity panel reflects the repo's current local config.
 * - `default` — nothing pinned locally; the repo uses the global git identity.
 * - `profile` — a saved profile is applied; `customEmail` / `customSigning` are
 *   true when the repo diverges from that profile's email / signing config.
 * - `unmanaged` — a local identity is pinned that matches no saved profile. */
export type ProfileSelection =
  | { kind: "default" }
  | { kind: "profile"; id: string; customEmail: boolean; customSigning: boolean }
  | { kind: "unmanaged" };

/** Compare the signing config (key + format + sign flag) of a profile against a
 * pinned identity, normalising "unset" (undefined / empty / false) so e.g. no
 * key equals an empty key. */
function sameSigning(
  a: Pick<GitProfile, "signingKey" | "gpgFormat" | "gpgSign" | "tagGpgSign">,
  b: Pick<RepoIdentity, "signingKey" | "gpgFormat" | "gpgSign" | "tagGpgSign">,
): boolean {
  return (
    (a.signingKey || "") === (b.signingKey || "") &&
    (a.gpgFormat || "") === (b.gpgFormat || "") &&
    Boolean(a.gpgSign) === Boolean(b.gpgSign) &&
    Boolean(a.tagGpgSign) === Boolean(b.tagGpgSign)
  );
}

/** Resolve which profile (if any) the repo's pinned identity corresponds to.
 * `appliedId` (the profile explicitly applied to this repo, persisted by id) is
 * preferred so duplicate git names — and custom emails that no longer match any
 * saved email — stay unambiguous. Without it, fall back to a name+email exact
 * hit, then name only. `null` identity → the default option; no match →
 * unmanaged. Email/signing divergence is reported via `customEmail` /
 * `customSigning`. */
export function selectProfile(
  repoIdentity: RepoIdentity | null,
  profiles: GitProfile[],
  appliedId?: string | null,
): ProfileSelection {
  if (!repoIdentity) return { kind: "default" };
  // Honor the applied profile only while it's still *compatible* with the repo's
  // current git config — i.e. the author name still matches. git config is the
  // source of truth, so an external `git config user.name …` change must surface
  // as a different profile / unmanaged rather than masquerading as the old one.
  // Email & signing may still diverge per-repo (reported via the custom flags).
  const applied = appliedId ? profiles.find((p) => p.id === appliedId) : undefined;
  const compatible = applied && applied.name === repoIdentity.name ? applied : undefined;
  const match =
    compatible ??
    profiles.find((p) => p.name === repoIdentity.name && p.email === repoIdentity.email) ??
    profiles.find((p) => p.name === repoIdentity.name);
  if (match) {
    return {
      kind: "profile",
      id: match.id,
      customEmail: match.email !== repoIdentity.email,
      customSigning: !sameSigning(match, repoIdentity),
    };
  }
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
