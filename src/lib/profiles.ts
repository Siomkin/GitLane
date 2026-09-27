// Git profiles — reusable, named commit identities (name + email + optional
// signing) that apply to any repo, independent of provider accounts. This is
// the pure data layer for identity cards and editor drafts.

import { initials } from "./ui";

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

/** A pragmatic "looks like an email" check shared by the profile editor and
 * persisted-card validation: one `@`, a dotted domain, and no whitespace. */
export function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
}

/** The signing badge label for a profile ("GPG signed" / "SSH signed"), or null
 * when it doesn't sign. */
export function signingLabel(profile: GitProfile): string | null {
  if (!profile.signingKey || (!profile.gpgSign && !profile.tagGpgSign)) return null;
  return profile.gpgFormat === "ssh" ? "SSH signed" : "GPG signed";
}

/** Avatar initials for a profile (from its label) — the app's one initials
 * rule, so an identity card and that person's commits read the same. */
export const profileInitials = (label: string): string => initials(label, "··");
