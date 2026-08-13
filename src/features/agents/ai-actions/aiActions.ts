// What the AI actions popup can write, and the prompt it hands the agent.
//
// Pure: no React, no IPC. The scope names *which* changes the agent should read
// (a commit, several commits, the working tree, or commits ending at the
// working tree) and the action names *what* to write about them. GitLane never
// ships a diff over IPC — the agent runs in the repository and reads it with
// read-only git, so the prompt only has to say which revisions to look at.
// What to write comes from Settings (Prompts) — `instructionFor` looks it up.

import type { AiActionCommand } from "@/lib/api";

export const AiActionId = {
  Short: "short",
  Full: "full",
  Impl: "impl",
  Release: "release",
  Review: "review",
  Test: "test",
  Custom: "custom",
} as const;

/** A picker id: a saved command id, or the one-shot Custom prompt. */
export type AiActionId = string;

export interface AiActionDef {
  id: AiActionId;
  label: string;
}

export const CUSTOM_ACTION: AiActionDef = { id: AiActionId.Custom, label: "Custom prompt" };

export function enabledAiActions(commands: readonly AiActionCommand[]): AiActionDef[] {
  return commands
    .filter((command) => command.enabled && command.title.trim() && command.instruction.trim())
    .map((command) => ({ id: command.id, label: command.title.trim() }));
}

/** Enabled saved commands in list order, then the one-shot Custom prompt. */
export function pickerActions(commands: readonly AiActionCommand[]): AiActionDef[] {
  return [...enabledAiActions(commands), CUSTOM_ACTION];
}

/** Review-all asks for `short`; menus omit an action and prefer Implementation
 *  comment. Disabled / missing ids fall back to the first enabled command. */
export function resolveAction(
  requested: string | null | undefined,
  commands: readonly AiActionCommand[],
): string {
  const enabled = enabledAiActions(commands);
  const enabledIds = new Set(enabled.map((command) => command.id));
  if (requested === AiActionId.Custom) return AiActionId.Custom;
  if (requested && enabledIds.has(requested)) return requested;
  if (!requested && enabledIds.has(AiActionId.Impl)) return AiActionId.Impl;
  return enabled[0]?.id ?? AiActionId.Custom;
}

export function aiActionDef(id: AiActionId, commands: readonly AiActionCommand[]): AiActionDef {
  if (id === AiActionId.Custom) return CUSTOM_ACTION;
  const command = commands.find((row) => row.id === id);
  if (command) return { id: command.id, label: command.title.trim() || "Untitled" };
  return enabledAiActions(commands)[0] ?? CUSTOM_ACTION;
}

export function instructionFor(action: AiActionId, commands: readonly AiActionCommand[]): string {
  if (action === AiActionId.Custom) return "";
  return commands.find((command) => command.id === action)?.instruction ?? "";
}

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

const short = (oid: string) => oid.slice(0, 7);

/** Header label: "3 commits", "1 commit", "Uncommitted changes", or the mixed
 *  pick that ends at the working tree. */
export function scopeLabel(scope: AiActionScope): string {
  switch (scope.kind) {
    case AiActionScopeKind.Working:
      return "Uncommitted changes";
    case AiActionScopeKind.Commits:
      return commitsLabel(scope.commits);
    case AiActionScopeKind.CommitsWithWorking:
    case AiActionScopeKind.Span:
      return `${commitsLabel(scope.commits)} + uncommitted`;
    case AiActionScopeKind.Range:
      return `Range ${short(scope.base)}..${short(scope.head)}`;
    default:
      return unhandledScope(scope);
  }
}

function commitsLabel(commits: readonly string[]): string {
  return commits.length === 1 ? `Commit ${short(commits[0])}` : `${commits.length} commits`;
}

/** Tells the agent which revisions to read. The wording mirrors the stacked
 *  review's description instruction, so both surfaces ask for the same thing. */
export function scopeSentence(scope: AiActionScope): string {
  const working =
    "the uncommitted changes in the working tree (`git diff HEAD`, plus untracked files)";
  switch (scope.kind) {
    case AiActionScopeKind.Working:
      return `Read ${working}.`;
    case AiActionScopeKind.Commits:
      return `Read ${commitsClause(scope.commits)}.`;
    case AiActionScopeKind.CommitsWithWorking:
      return `Read ${commitsClause(scope.commits)}, together with ${working}.`;
    case AiActionScopeKind.Span:
      // One span, base → working tree: the merged selection the graph paints.
      return `Read everything since ${scope.base} as one combined change, up to and including the uncommitted changes in the working tree (\`git diff ${scope.base}\`, plus untracked files).`;
    case AiActionScopeKind.Range:
      return `Read the changes in ${scope.base}..${scope.head} (\`git diff ${scope.base} ${scope.head}\`).`;
    default:
      return unhandledScope(scope);
  }
}

function commitsClause(commits: readonly string[]): string {
  return commits.length === 1
    ? `commit ${commits[0]} (\`git show ${commits[0]}\`)`
    : `these commits as one combined change: ${commits.join(", ")}`;
}

/** A Jira-style issue key carried by the branch name (`feature/GL-142-thing`),
 *  or null. Worth passing to the agent — an implementation comment that names
 *  the ticket is the one the user was going to paste anyway. */
export function jiraKeyFrom(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const match = branch.match(/(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?:[^0-9]|$)/);
  return match ? match[1] : null;
}

/** The whole prompt: what to read, what to write, and the user's own notes.
 *  The evidence clause is deliberate — these actions summarise a diff, and a
 *  codebase-wide exploration turns a 10-second answer into a 3-minute one. */
export function buildAiActionPrompt({
  scope,
  action,
  extra,
  jiraKey,
  instruction,
}: {
  scope: AiActionScope;
  action: AiActionId;
  extra: string;
  jiraKey?: string | null;
  instruction: string;
}): string {
  const notes = extra.trim();
  const custom = action === AiActionId.Custom;
  const parts = [
    scopeSentence(scope),
    custom
      ? "You may read skill or instruction files the user invoked. Do not search the rest of the codebase or run tests."
      : "Read the diff only — do not open unrelated files, run tests, or search the codebase.",
    instruction,
  ];
  if (jiraKey) {
    parts.push(`This work is tracked as ${jiraKey}; reference that key where it reads naturally.`);
  }
  if (notes) parts.push(custom ? notes : `Also: ${notes}`);
  if (custom) parts.push("Reply with the final result and nothing else. No preamble or plan.");
  return parts.filter(Boolean).join(" ");
}

/** The graph selection as a scope, or null when there's nothing to describe. */
export function scopeFromSelection({
  selectedCommits,
  selectedCommit,
  wipSelected,
  workingBase = null,
}: {
  selectedCommits: string[];
  selectedCommit: string | null;
  wipSelected: boolean;
  /** `selectionDiff.workingBase` — set when the pick merges commits and WIP. */
  workingBase?: string | null;
}): AiActionScope | null {
  const commits =
    selectedCommits.length > 0 ? selectedCommits : selectedCommit ? [selectedCommit] : [];
  if (commits.length === 0) return wipSelected ? { kind: AiActionScopeKind.Working } : null;
  if (!wipSelected) return { kind: AiActionScopeKind.Commits, commits };
  // A merged pick only becomes a span once the store could express one; until
  // then it is two reads, not one.
  return workingBase
    ? { kind: AiActionScopeKind.Span, base: workingBase, commits }
    : { kind: AiActionScopeKind.CommitsWithWorking, commits };
}

/** The stacked review-all surface as an AI-actions scope. */
export function scopeFromStackedReview(review: {
  oid: string;
  range?: { base: string; head: string };
  selection?: string[];
}): AiActionScope {
  if (review.selection && review.selection.length > 0) {
    return { kind: AiActionScopeKind.Commits, commits: review.selection };
  }
  if (review.range) {
    return { kind: AiActionScopeKind.Range, base: review.range.base, head: review.range.head };
  }
  return { kind: AiActionScopeKind.Commits, commits: [review.oid] };
}

export function extraPlaceholder(action: AiActionId, label: string): string {
  if (action === AiActionId.Custom) {
    return "Describe what you want written about these changes…";
  }
  return `Extra instructions for ${label.toLowerCase()} (optional) — tone, length, audience…`;
}

export interface ChangeTally {
  count: number;
  add: number;
  del: number;
}

/** Line totals for a file list. Callers pass already-deduped paths. */
export function tallyChanges(files: readonly { add: number; del: number }[]): ChangeTally {
  let add = 0;
  let del = 0;
  for (const file of files) {
    add += file.add;
    del += file.del;
  }
  return { count: files.length, add, del };
}

export function formatTally(tally: ChangeTally): { stats: string; add: string; del: string } {
  return {
    stats: tally.count === 1 ? "1 file" : `${tally.count} files`,
    add: `+${tally.add}`,
    del: `−${tally.del}`,
  };
}

/** One row per path, summing add/del when the same file appears in several lists
 *  (staged + unstaged). Status/mark of the first hit wins. */
export function mergeFileRows<T extends { path: string; add: number; del: number }>(
  lists: readonly T[][],
): T[] {
  const byPath = new Map<string, T>();
  for (const list of lists) {
    for (const file of list) {
      const prev = byPath.get(file.path);
      if (!prev) byPath.set(file.path, file);
      else byPath.set(file.path, { ...prev, add: prev.add + file.add, del: prev.del + file.del });
    }
  }
  return [...byPath.values()];
}
