// The commit-identity model (GL-130, flattened): identities are plain saved
// cards — name + email (+ optional signing), the old GitProfile shape — and a
// repo either pins one to its local git config or defaults to **this
// computer** (the global config). Connected accounts are NOT an identity
// kind: they only offer a one-click prefill when creating a card ("New
// identity from @login"), and otherwise exist purely for auth. This is the
// pure layer: the selection *hint* that maps a repo's pinned identity back
// onto a card, the GitHub noreply helper for prefills, and the storage
// migrations from the pre-GL-130 keys. No React, no zustand, no IPC.

import type { RepoIdentity } from "./api";
import { type GitProfile } from "./profiles";

/** An identity card is exactly the old git profile — same storage, same
 * fields; only the UI vocabulary changed. */
export type ManualIdentity = GitProfile;

/** What a repo's "commit as" pick points at. "This computer" is the absence
 * of a ref (nothing pinned in local git config). The shape stays a tagged
 * union for storage stability. */
export type CommitSourceRef = { kind: "manual"; id: string };

/** Which card the repo's current local config corresponds to — a display
 * *hint*, not an enforced state: the identity fields are always editable and
 * this just labels what the current values match.
 *
 * The anchor is the **email**: forges attribute commits by email only, so a
 * card link holds while the email is one the card knows (its own email or the
 * stored per-repo override) and a custom author name is reported via
 * `customName`, never treated as a break. */
export type CommitSelection =
  | { kind: "computer" }
  | {
      kind: "manual";
      id: string;
      customEmail: boolean;
      customName: boolean;
      customSigning: boolean;
    }
  | { kind: "unmanaged" };

/** Stable per-card key for the custom-email override map. */
export function sourceKey(ref: CommitSourceRef): string {
  return `manual:${ref.id}`;
}

/** The GitHub noreply address for an account, or null when it can't be built:
 * the numeric user id is required (an unresolved/unhealthy account degrades
 * its id to the login). GHES instances use their own noreply domain. Used to
 * prefill "New identity from @login". */
export function noreplyEmail(a: {
  accountId: string;
  login: string;
  host: string;
}): string | null {
  if (!/^\d+$/.test(a.accountId)) return null;
  return `${a.accountId}+${a.login}@users.noreply.${a.host}`;
}

/** Signing equality against a pinned identity, normalising "unset". */
function sameSigning(
  a: Pick<RepoIdentity, "signingKey" | "gpgFormat" | "gpgSign" | "tagGpgSign">,
  b: Pick<RepoIdentity, "signingKey" | "gpgFormat" | "gpgSign" | "tagGpgSign">,
): boolean {
  return (
    (a.signingKey || "") === (b.signingKey || "") &&
    (a.gpgFormat || "") === (b.gpgFormat || "") &&
    Boolean(a.gpgSign) === Boolean(b.gpgSign) &&
    Boolean(a.tagGpgSign) === Boolean(b.tagGpgSign)
  );
}

function sameAuthor(a: RepoIdentity, b: RepoIdentity): boolean {
  return a.name === b.name && a.email === b.email;
}

/**
 * Resolve which card the repo's pinned identity corresponds to — a hint for
 * the identity panel, never a constraint on editing.
 *
 * Rules:
 * - Nothing pinned → this computer.
 * - A local pin with the same name/email as this computer's global identity
 *   also resolves as this computer; it is a redundant repo-local author, not a
 *   different profile. Signing config is intentionally ignored for this
 *   collapse because the visible "who commits as" identity is name/email.
 * - The explicitly applied card wins while the pinned **email** is still one
 *   it knows (its own email, or the per-repo override in `overrides`, keyed
 *   by source key). A custom author name is reported via `customName` — git
 *   names are free-form display text and never break the link. An email the
 *   card doesn't know does break it (attribution changed), falling through.
 * - Without an applied ref: an exact name+email match first, then an
 *   unambiguous email-only match.
 * - No match → unmanaged (a legitimate custom identity, not an error).
 */
export function selectCommitSource(
  repoIdentity: RepoIdentity | null,
  manuals: ManualIdentity[],
  applied: CommitSourceRef | null,
  overrides: Record<string, string> = {},
  defaultIdentity: RepoIdentity | null = null,
): CommitSelection {
  if (!repoIdentity) return { kind: "computer" };
  if (defaultIdentity && sameAuthor(repoIdentity, defaultIdentity)) return { kind: "computer" };
  const email = repoIdentity.email;

  const cardHint = (card: ManualIdentity): CommitSelection | null => {
    const override = overrides[sourceKey({ kind: "manual", id: card.id })] ?? null;
    const known = [card.email, override].filter((e): e is string => Boolean(e));
    if (!known.includes(email)) return null;
    return {
      kind: "manual",
      id: card.id,
      customEmail: email === override && override !== card.email,
      customName: repoIdentity.name !== card.name,
      customSigning: !sameSigning(card, repoIdentity),
    };
  };

  if (applied) {
    const card = manuals.find((p) => p.id === applied.id);
    const hint = card ? cardHint(card) : null;
    if (hint) return hint;
  }

  const exact = manuals.find((p) => p.name === repoIdentity.name && p.email === email);
  if (exact) return cardHint(exact)!;
  const byEmail = manuals.filter((p) => p.email === email);
  if (byEmail.length === 1) return cardHint(byEmail[0])!;

  return { kind: "unmanaged" };
}

// ---- storage migrations (pre-GL-130 profile-only keys) ----
//
// Value-shape migrations are pure over plain objects; the store wires them to
// localStorage once at load. Key migration from worktree paths to the shared
// repo-identity key stays lazy per repo open (only then is the main checkout
// path known) — same pattern as `accounts.ts`.

/** `gitlane.repoProfile` `{ [repoPath]: profileId }` →
 * `gitlane.repoCommitSource` `{ [repoPath]: {kind:"manual", id} }`. */
export function migrateAppliedProfileMap(
  old: Record<string, unknown>,
): Record<string, CommitSourceRef> {
  const out: Record<string, CommitSourceRef> = {};
  for (const [path, id] of Object.entries(old)) {
    if (typeof id === "string" && id) out[path] = { kind: "manual", id };
  }
  return out;
}

/** `gitlane.repoProfileEmail` `{ [repoPath]: { [profileId]: email } }` →
 * `gitlane.repoCommitEmail` `{ [repoPath]: { ["manual:"+id]: email } }`. */
export function migrateCustomEmailMap(
  old: Record<string, unknown>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [path, entry] of Object.entries(old)) {
    if (!entry || typeof entry !== "object") continue;
    const perSource: Record<string, string> = {};
    for (const [profileId, email] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof email === "string" && email) {
        perSource[sourceKey({ kind: "manual", id: profileId })] = email;
      }
    }
    if (Object.keys(perSource).length > 0) out[path] = perSource;
  }
  return out;
}
