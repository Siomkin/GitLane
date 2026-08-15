// Deriving the CapturedIdentity wire payload for commit-creating writes.
// Shared by the commit/squash/squash-range/continue/skip wrappers so the
// notCaptured / capturedNone / card decision lives in exactly one place.

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
