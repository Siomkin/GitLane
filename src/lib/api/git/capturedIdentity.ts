// Deriving the CapturedIdentity wire payload for commit-creating writes.
// Shared by the conflict continue/skip wrappers and the store's commit and
// history write actions, so the notCaptured / capturedNone / card decision
// lives in exactly one place.

import type { CapturedIdentity, RepoIdentity } from "./types";

/**
 * Map the wrappers' `identity?: RepoIdentity | null` argument onto the Rust
 * `CapturedIdentity` tagged enum: `undefined` means the caller never read the
 * repo identity; `null` means it read one and the repo had none ("this
 * computer"); a card means it read this card.
 */
export function capturedIdentityArg(
  identity: RepoIdentity | null | undefined,
): CapturedIdentity {
  if (identity === undefined) return { mode: "notCaptured" };
  if (identity === null) return { mode: "capturedNone" };
  return { mode: "card", identity };
}

/** The commit-identity fields every commit-creating write sends: the pinned
 * author/committer name and email plus the captured-identity payload, from the
 * one repo identity the caller read. */
export function commitIdentityFields(identity: RepoIdentity | null | undefined): {
  name?: string;
  email?: string;
  identity: CapturedIdentity;
} {
  return {
    name: identity?.name,
    email: identity?.email,
    identity: capturedIdentityArg(identity),
  };
}
