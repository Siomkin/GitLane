// Pure derivations for the file-history view (GL-193): which entry is
// selected, whether the file was deleted, and the header's revision count
// label. No React, no store.
import type { FileHistoryEntry } from "../../../lib/api";

export function selectedEntry(entries: FileHistoryEntry[], selectedOid: string | null): FileHistoryEntry | null {
  return entries.find((e) => e.oid === selectedOid) ?? null;
}

/** The deletion marker, when this history ends in the file being deleted. */
export function deletedEntry(entries: FileHistoryEntry[]): FileHistoryEntry | null {
  return entries.find((e) => e.status === "D") ?? null;
}

/** The header count: hidden while loading, "N+" when the backend capped the walk. */
export function revisionCountLabel(count: number, truncated: boolean, loading: boolean): string {
  return loading ? "" : `${count}${truncated ? "+" : ""}`;
}
