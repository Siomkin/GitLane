import type { FileChange } from "@/lib/api";

/** ADR 0003: Restore is offered when the path has a restoreable blob at the
 * selected commit — not for deletes, submodules, or directory headers. */
export function canRestoreCommittedFile(
  file: FileChange | undefined,
  commitOid: string | undefined,
): boolean {
  return (
    !!commitOid &&
    !!file &&
    file.status !== "D" &&
    file.advanced?.kind !== "submodule"
  );
}
