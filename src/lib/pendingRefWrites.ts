// The ref writes in flight in one repository (delete, rename, push, tag
// delete/push): what the store records while they run and how a graph ref pill
// matches them. Unlike a pending checkout, a pending write refuses nothing.

import { RefKind, type RefLabel } from "@/lib/api";

/** A ref a running write acts on, by the pill kind it shows as. */
export interface PendingWriteRef {
  name: string;
  kind: "local" | "remote" | "tag";
}

/** One running ref write (delete, rename, push, tag delete/push). */
export interface PendingRefWrite {
  id: number;
  refs: readonly PendingWriteRef[];
}

/** Whether `label`'s pill is a ref a running write acts on. */
export function writeMatchesLabel(ref: PendingWriteRef, label: RefLabel): boolean {
  if (ref.name !== label.name) return false;
  switch (label.kind) {
    case RefKind.Branch:
      return ref.kind === "local";
    case RefKind.Remote:
      return ref.kind === "remote";
    case RefKind.Tag:
      return ref.kind === "tag";
    default:
      return false;
  }
}
