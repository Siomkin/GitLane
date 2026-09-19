// The changes an AI action runs over — a pure domain shape. It lives in `lib`
// because both the agents feature and the ui store's dialog slice name it, and
// the store never imports a feature. `features/agents/ai-actions/aiActions.ts`
// re-exports everything here.

export const AiActionScopeKind = {
  /** The uncommitted WIP row alone. */
  Working: "working",
  /** A commit or a multi-commit pick, with no working tree involved. */
  Commits: "commits",
  /** Commits picked *with* the WIP row but with no base to diff from, so the
   *  agent makes two separate reads.
   *
   *  No producer emits this today: the store sets `wipSelected` only when
   *  `workingRange` yielded a base, and writes that base onto `selectionDiff`
   *  in the same `set()` — so a pick that cannot span simply drops the WIP row
   *  (`repoSelectionActions.ts`). It stays as the safe branch for a violated
   *  invariant: without it `scopeFromSelection` would have to silently drop
   *  either the commits or the working tree from the prompt. */
  CommitsWithWorking: "commitsWithWorking",
  /** Commits picked with the WIP row as one span ending at the working tree —
   *  `selectionDiff.workingBase`, the same surface ⌘↵ review opens. One read. */
  Span: "span",
  /** Combined `git diff base head`, from range review-all. Not a commit list. */
  Range: "range",
} as const;
export type AiActionScopeKind = (typeof AiActionScopeKind)[keyof typeof AiActionScopeKind];

/** The changes an AI action runs over. One variant per thing the agent is
 *  actually asked to read, so the label, the prompt sentence and the file tally
 *  cannot answer the question differently — they switch over the same `kind`
 *  and the compiler rejects a missing arm. `commits` is newest-first (graph
 *  order) wherever it appears. */
export type AiActionScope =
  | { kind: typeof AiActionScopeKind.Working }
  | { kind: typeof AiActionScopeKind.Commits; commits: string[] }
  | { kind: typeof AiActionScopeKind.CommitsWithWorking; commits: string[] }
  | { kind: typeof AiActionScopeKind.Span; base: string; commits: string[] }
  | { kind: typeof AiActionScopeKind.Range; base: string; head: string };

/** The commits a scope names, for the header's commit rows. Empty for a range —
 *  its endpoints are not a commit list. */
export function scopeCommits(scope: AiActionScope): string[] {
  return "commits" in scope ? scope.commits : [];
}

/** Whether the uncommitted working tree is part of what the agent reads — the
 *  header lists working-tree file rows for exactly these. */
export function scopeIncludesWorking(scope: AiActionScope): boolean {
  return (
    scope.kind === AiActionScopeKind.Working ||
    scope.kind === AiActionScopeKind.CommitsWithWorking ||
    scope.kind === AiActionScopeKind.Span
  );
}

/** Unreachable-by-construction guard: adding a variant without extending a
 *  switch becomes a type error here rather than a silent fallthrough. */
export function unhandledScope(scope: never): never {
  throw new Error(`unhandled AI action scope: ${JSON.stringify(scope)}`);
}
