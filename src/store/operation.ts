// Pure helpers for the active merge/sequencer operation state — no Zustand, no
// IPC, so they're trivially testable (mirrors `selection.ts`). The store calls
// `mergeOperationStatus` whenever it re-reads `operation_status` from the
// backend; the conflict workspace consumes the resulting `OperationState`.

import type { OperationStatus } from "@/lib/api";
import type { OperationFile, OperationState } from "./repoTypes";

/**
 * Fold a fresh backend `operation_status` into the prior operation state.
 *
 * The backend only reports *still-conflicted* files (a resolved file leaves the
 * index conflict set entirely). To keep the file list and the "N/M resolved"
 * progress stable as the user works, we keep a union of every file the
 * operation has touched: a previously-known file that's no longer reported is
 * marked `resolved`, while still-reported files stay unresolved.
 *
 * `prev` is reused only when it belongs to the *same* operation kind — a new
 * operation (or one started from a terminal) starts the union fresh. Returns
 * `null` when no operation is active.
 */
export function mergeOperationStatus(
  prev: OperationState | null,
  status: OperationStatus,
): OperationState | null {
  // Tolerate an absent/odd payload (e.g. a `none` state) — only a real
  // merge/sequencer kind (or GL-74's "carry") produces an operation; anything
  // else clears it.
  const kind = status?.kind;
  if (
    kind !== "merge" &&
    kind !== "rebase" &&
    kind !== "cherry-pick" &&
    kind !== "revert" &&
    kind !== "carry"
  ) {
    return null;
  }
  const conflicts = Array.isArray(status.conflicts) ? status.conflicts : [];

  const base = prev && prev.kind === kind ? prev : null;
  const current = new Map(conflicts.map((c) => [c.path, c]));
  const seen = new Set<string>();
  const files: OperationFile[] = [];

  // Preserve prior order so the list never reshuffles while resolving.
  for (const file of base?.files ?? []) {
    seen.add(file.path);
    const cur = current.get(file.path);
    files.push(
      cur
        ? { path: cur.path, kind: cur.kind, deletedSide: cur.deletedSide, resolved: false }
        : { ...file, resolved: true },
    );
  }
  // Append conflicts not already in the union (fresh operation, or new files
  // surfaced by a later rebase/cherry-pick step).
  for (const c of conflicts) {
    if (seen.has(c.path)) continue;
    files.push({ path: c.path, kind: c.kind, deletedSide: c.deletedSide, resolved: false });
  }

  return { kind, canSkip: !!status.canSkip, files };
}

/** Human-facing verb for an operation kind ("merge" → "Merge", etc.). */
export function operationLabel(kind: OperationState["kind"]): string {
  switch (kind) {
    case "merge":
      return "Merge";
    case "rebase":
      return "Rebase";
    case "cherry-pick":
      return "Cherry-pick";
    case "revert":
      return "Revert";
    case "carry":
      return "Carry";
  }
}
