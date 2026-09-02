import { BranchKind } from "./api";

/** A drag source is always a local or remote-tracking branch — same vocabulary
 * as `BranchKind`. */
export type BranchRefKind = BranchKind;

export interface BranchDragRef {
  name: string;
  kind: BranchRefKind;
}

/** Kind of a graph drop target: a branch (local/remote) or a bare commit.
 * Compare against `GraphTargetKind.Commit`, not `"commit"`. */
export const GraphTargetKind = {
  Local: BranchKind.Local,
  Remote: BranchKind.Remote,
  Commit: "commit",
} as const;
export type GraphTargetKind = (typeof GraphTargetKind)[keyof typeof GraphTargetKind];

export type GraphDropTarget =
  | { kind: typeof GraphTargetKind.Local; name: string }
  | { kind: typeof GraphTargetKind.Remote; name: string }
  | { kind: typeof GraphTargetKind.Commit; sha: string; shortSha: string };

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
 * into the target.
 *
 * A remote source still cannot be mutated in place. Merge / fast-forward / reset
 * therefore move the local target onto the remote. Rebase is the exception: when
 * the remote's local counterpart is a *different* branch than the drop target,
 * rebase moves that counterpart onto the target (check it out / create it first)
 * instead of rebasing the target onto the remote. Dropping a remote on its own
 * counterpart, or when the counterpart name is unknown, keeps the old
 * feed-the-target rebase. */
export function buildGraphActionSpecs(
  source: BranchDragRef,
  target: GraphDropTarget,
  ff: FastForwardMoves,
  sourceLocalName?: string | null,
): GraphActionSpec[] {
  // A commit or a remote-tracking ref is a fixed point: only the dragged local
  // branch can move onto it. The label reads the target's short sha (commit) or
  // ref name (remote).
  if (target.kind === GraphTargetKind.Commit || target.kind === GraphTargetKind.Remote) {
    if (source.kind !== BranchKind.Local) return [];
    const at = target.kind === GraphTargetKind.Commit ? target.shortSha : target.name;
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
  if (source.kind === BranchKind.Local) {
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

  // Remote source feeding a local target. Merge / FF / reset still move the
  // target (the remote ref itself is read-only). Rebase of a *different*
  // counterpart replays that local branch onto the target instead.
  const rebaseCounterpart = sourceLocalName != null
    && sourceLocalName !== ""
    && sourceLocalName !== target.name;
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
    rebaseCounterpart
      ? {
          kind: "rebase-source" as const,
          label: `Rebase ${sourceLocalName} onto ${target.name}`,
          sub: "Replay branch commits on top",
        }
      : {
          kind: "rebase-target" as const,
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
