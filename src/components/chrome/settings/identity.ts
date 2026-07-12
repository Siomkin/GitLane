// Pure validation helpers for the commit-identity editor — no React, no IPC, so
// the dirty/valid rules that gate the Save button are testable in isolation.

import type { RepoIdentity } from "@/store/accounts";

/** A pragmatic "looks like an email" check: one `@`, a dotted domain, no spaces. */
export function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
}

/** Both fields must be present and the email well-formed before a save is offered. */
export function isIdentityValid(name: string, email: string): boolean {
  return name.trim() !== "" && isValidEmail(email);
}

/** Has the edited identity diverged from what's currently pinned? */
export function isIdentityDirty(
  name: string,
  email: string,
  identity: RepoIdentity | null,
): boolean {
  return name !== (identity?.name ?? "") || email !== (identity?.email ?? "");
}
