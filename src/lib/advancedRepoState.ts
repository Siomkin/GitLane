import type { AdvancedRepoState, FileChange, WorkingChanges } from "./api";

export const emptyAdvancedState: AdvancedRepoState = {
  submodules: [],
  lfs: { detected: false, installed: null, issues: [], patterns: [] },
  sparseCheckout: { enabled: false, mode: null, patterns: [], truncated: false },
};

export const advancedState = (changes: WorkingChanges): AdvancedRepoState =>
  changes.advanced ?? emptyAdvancedState;

export const advancedNotices = (changes: WorkingChanges): string[] => {
  const advanced = advancedState(changes);
  const notices: string[] = [];

  if (advanced.submodules.length > 0) {
    const dirty = advanced.submodules.filter((submodule) => submodule.dirty || !submodule.initialized);
    notices.push(
      dirty.length > 0
        ? `${dirty.length} submodule ${dirty.length === 1 ? "has" : "have"} changes. Use git submodule commands or the terminal to update submodule internals.`
        : `${advanced.submodules.length} submodule ${advanced.submodules.length === 1 ? "is" : "are"} configured. GitLane shows submodule state but does not update submodules yet.`,
    );
  }
  if (advanced.lfs.issues.length > 0) {
    notices.push(advanced.lfs.issues[0]);
  }
  if (advanced.sparseCheckout.enabled) {
    notices.push("Sparse checkout is enabled. The working tree is limited to selected paths; committed files outside the sparse set can still appear in history.");
    if (advanced.sparseCheckout.truncated) {
      // The pattern list was capped (see fileWriteGuard): GitLane can't verify
      // every path against it, so its outside-checkout warnings become
      // best-effort. Say so, and reassure that git itself still enforces the
      // sparse rules when the change is actually staged/committed.
      notices.push("This sparse checkout has more patterns than GitLane inspects, so some outside-checkout warnings may be missing. Git still applies the sparse rules when you stage or commit.");
    }
  }

  return notices;
};

export const advancedFileGuard = (file: FileChange | undefined): string | null => {
  if (!file?.advanced) return null;
  if (file.advanced.kind === "submodule") {
    return `${file.advanced.message}. Use the terminal for submodule updates.`;
  }
  if (file.advanced.kind === "sparse") {
    return `${file.advanced.message}. Expand the sparse checkout or use git add --sparse.`;
  }
  return file.advanced.message;
};

export const fileWriteGuard = (
  file: FileChange | undefined,
  changes: WorkingChanges,
): string | null => {
  const explicit = advancedFileGuard(file);
  if (explicit || !file) return explicit;

  // libgit2 can omit visible-but-outside-sparse paths from status, so the UI
  // also checks sparse patterns before offering write actions for visible rows.
  // Skip this when the backend truncated the pattern list: a non-match is then
  // inconclusive (a later, unsent pattern may include the path), and the
  // authoritative skip-worktree annotation above already blocks tracked
  // outside-sparse files. Blocking here on a partial list would falsely reject
  // valid stage/commit for files included by a pattern we never received.
  const sparse = advancedState(changes).sparseCheckout;
  if (
    sparse.enabled &&
    !sparse.truncated &&
    !pathIsInSparseCheckout(file.path, sparse.patterns)
  ) {
    return "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.";
  }

  return null;
};

export const findGuardedFile = (
  files: FileChange[],
  changes: WorkingChanges,
): FileChange | undefined => files.find((file) => !!fileWriteGuard(file, changes));

export const guardedAdvancedWriteMessage = (changes: WorkingChanges): string | null => {
  const first = findGuardedFile([...changes.unstaged, ...changes.staged], changes);
  if (first) return fileWriteGuard(first, changes);
  const submodule = advancedState(changes).submodules.find(
    (entry) => entry.dirty || !entry.initialized,
  );
  if (submodule) return `Submodule: ${submodule.status}. Use the terminal for submodule updates.`;
  return null;
};

const pathIsInSparseCheckout = (path: string, patterns: string[]): boolean => {
  if (patterns.length === 0) return true;
  let included = false;

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern || pattern.startsWith("#")) continue;
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (sparsePatternMatches(path, body)) included = !negated;
  }

  return included;
};

const sparsePatternMatches = (path: string, rawPattern: string): boolean => {
  const pattern = rawPattern.replace(/^\/+/, "");
  if (pattern === "*") return !path.includes("/");
  if (pattern === "*/") return path.includes("/");
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`).test(path);
  }
  return path === pattern || path.startsWith(`${pattern}/`);
};
