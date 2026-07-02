export type BranchRefKind = "local" | "remote";

export interface BranchDragRef {
  name: string;
  kind: BranchRefKind;
}

export type GraphDropTarget =
  | { kind: "local"; name: string }
  | { kind: "remote"; name: string }
  | { kind: "commit"; sha: string; shortSha: string };

export interface FastForwardMoves {
  /** The local target branch can move forward to the dragged source ref. */
  targetToSource: boolean;
  /** The dragged local branch can move forward to the drop target. */
  sourceToTarget: boolean;
}

export type GraphActionKind =
  | "fast-forward-target"
  | "fast-forward-source"
  | "merge-target"
  | "rebase-target"
  | "reset-target"
  | "rebase-source"
  | "reset-source";

export interface GraphActionSpec {
  kind: GraphActionKind;
  label: string;
  sub: string;
}

export interface WorktreeRef {
  path: string;
  branch: string | null;
}

/** Find another worktree that already owns `branch`. Git refuses to check out
 * one branch in two worktrees, including when the other owner is the main
 * worktree. */
export function findOtherBranchWorktree(
  worktrees: WorktreeRef[],
  branch: string,
  currentWorkdir: string,
): WorktreeRef | null {
  const normalize = (path: string) => path.replace(/\/+$/, "");
  const current = normalize(currentWorkdir);
  return worktrees.find(
    (worktree) =>
      worktree.branch === branch &&
      normalize(worktree.path) !== current,
  ) ?? null;
}

/** Pure policy for the graph drag menu. The drag gesture fixes the direction:
 * the dragged ref is the actor, so the operation moves it onto the drop target
 * — never the reverse. Offering both directions would let a drop silently move
 * the target instead, the exact confusion this menu must avoid.
 *
 * Only local branches can be mutated. Commits and remote refs are read-only drop
 * targets: a dragged local branch moves onto them (fast-forward / rebase / reset).
 * A local drop target adds a merge option, still integrating the dragged branch
 * into the target. The one asymmetry: a *remote* source can't be mutated, so
 * dropping it on a local target moves the target instead (it feeds the target) —
 * the only direction available there, so there's still no ambiguity. */
export function buildGraphActionSpecs(
  source: BranchDragRef,
  target: GraphDropTarget,
  ff: FastForwardMoves,
): GraphActionSpec[] {
  // A commit or a remote-tracking ref is a fixed point: only the dragged local
  // branch can move onto it. The label reads the target's short sha (commit) or
  // ref name (remote).
  if (target.kind === "commit" || target.kind === "remote") {
    if (source.kind !== "local") return [];
    const at = target.kind === "commit" ? target.shortSha : target.name;
    return [
      ...(ff.sourceToTarget
        ? [{
            kind: "fast-forward-source" as const,
            label: `Fast-forward ${source.name} to ${at}`,
            sub: "No merge commit",
          }]
        : []),
      {
        kind: "rebase-source",
        label: `Rebase ${source.name} onto ${at}`,
        sub: "Replay branch commits on top",
      },
      {
        kind: "reset-source",
        label: `Reset ${source.name} to ${at}`,
        sub: "Move branch pointer (confirmation required)",
      },
    ];
  }

  // Local source dropped on a local target: the dragged branch moves onto the
  // target. Single direction — the target is never rebased/reset here.
  if (source.kind === "local") {
    return [
      ...(ff.sourceToTarget
        ? [{
            kind: "fast-forward-source" as const,
            label: `Fast-forward ${source.name} to ${target.name}`,
            sub: "No merge commit",
          }]
        : []),
      {
        kind: "merge-target",
        label: `Merge ${source.name} into ${target.name}`,
        sub: "Create a merge commit",
      },
      {
        kind: "rebase-source",
        label: `Rebase ${source.name} onto ${target.name}`,
        sub: "Replay branch commits on top",
      },
      {
        kind: "reset-source",
        label: `Reset ${source.name} to ${target.name}`,
        sub: "Move branch pointer (confirmation required)",
      },
    ];
  }

  // Remote source feeding a local target: the remote can't be mutated, so the
  // target is the only side that can move — it's rebased/reset onto the remote.
  return [
    ...(ff.targetToSource
      ? [{
          kind: "fast-forward-target" as const,
          label: `Fast-forward ${target.name} to ${source.name}`,
          sub: "No merge commit",
        }]
      : []),
    {
      kind: "merge-target",
      label: `Merge ${source.name} into ${target.name}`,
      sub: "Create a merge commit",
    },
    {
      kind: "rebase-target",
      label: `Rebase ${target.name} onto ${source.name}`,
      sub: "Replay target commits on top",
    },
    {
      kind: "reset-target",
      label: `Reset ${target.name} to ${source.name}`,
      sub: "Move branch pointer (confirmation required)",
    },
  ];
}
