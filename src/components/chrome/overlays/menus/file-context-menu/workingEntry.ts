import type { FileChange } from "@/lib/api";

export function lookupWorkingEntry(
  unstaged: FileChange[],
  staged: FileChange[],
  path: string,
  stagedBucket: boolean | undefined,
): FileChange | undefined {
  if (stagedBucket === true) return staged.find((file) => file.path === path);
  if (stagedBucket === false) return unstaged.find((file) => file.path === path);
  return unstaged.find((file) => file.path === path) ?? staged.find((file) => file.path === path);
}
