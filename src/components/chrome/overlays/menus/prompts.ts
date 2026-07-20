import { BranchKind, type BranchInfo } from "@/lib/api";
import { validateBranchName } from "@/lib/refName";
import type { RepoState } from "@/store/repoTypes";
import type { PromptRequest } from "@/store/ui";

export type PromptFn = (req: PromptRequest) => void;
export type RunFn = (op: () => Promise<string>) => void;

interface CreateWorktreePromptOptions {
  /** The reference is a commit/tag, so the new worktree has no branch. */
  detached?: boolean;
  /** A branch is already checked out elsewhere, forcing this worktree to use
   * its captured tip without checking out the branch itself. */
  detachedAt?: string;
}

/** A sibling directory path for a new worktree: `/work/repo` + `feat/x` →
 * `/work/repo-wt-feat-x`. Pre-fills the create-worktree prompt. */
function defaultWorktreePath(base: string, ref: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const safe = ref.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${trimmed}-wt-${safe || "detached"}`;
}

/** Prompt for a path, then create + open a worktree checked out to `reference`.
 * The copy names whether it opens on a branch or without one; "linked" is an
 * implementation detail shared by both states, not a user-facing alternative. */
export function promptCreateWorktree(
  requestPrompt: PromptFn,
  run: RunFn,
  createWorktreeAt: (path: string, ref: string) => Promise<string>,
  reference: string,
  workdir: string,
  label: string,
  options: CreateWorktreePromptOptions = {},
) {
  const { detached, detachedAt } = options;
  requestPrompt({
    title: `Create worktree from ${label}`,
    message: detachedAt
      ? `${label} is already checked out, so a new worktree is created without a branch at its tip (${detachedAt}), then opened.`
      : detached
        ? "A new worktree is created at this commit without a branch, then opened."
        : `A new worktree is created with ${label} checked out, then opened.`,
    placeholder: "/path/to/worktree",
    defaultValue: defaultWorktreePath(workdir, label),
    confirmLabel: "Create worktree",
    onSubmit: (path) => run(() => createWorktreeAt(path, reference)),
  });
}

/** Prompt for a new branch name, then create a worktree that checks out a fresh
 * branch of that name starting at `reference` (`git worktree add -b`). The
 * worktree path is derived from the branch name; the branch name is validated
 * with the same `check-ref-format` rules as Create/Rename branch. */
export function promptNewBranchWorktree(
  requestPrompt: PromptFn,
  run: RunFn,
  createWorktreeAt: (path: string, ref: string, newBranch?: string) => Promise<string>,
  reference: string,
  workdir: string,
  label: string,
) {
  requestPrompt({
    title: `New branch in a worktree from ${label}`,
    message: "A new branch is created at this point and checked out in a new worktree.",
    placeholder: "feature/my-branch",
    confirmLabel: "Create branch & worktree",
    validate: validateBranchName,
    onSubmit: (name) =>
      run(() => createWorktreeAt(defaultWorktreePath(workdir, name), reference, name)),
  });
}

/** Branch-picker prompt for "Compare <head> with…": offers the repo's other
 * branches (current first, then locals, then remotes) as a searchable list so
 * the user selects the comparison base instead of typing it. The selected
 * branch becomes the diff base. */
export function promptCompareBranch(
  requestPrompt: PromptFn,
  openCompare: RepoState["openCompare"],
  branches: BranchInfo[],
  head: string,
  cur: string | null,
) {
  const others = branches.filter((x) => x.name !== head);
  const locals = others
    .filter((x) => x.kind === BranchKind.Local)
    .sort((x, y) => (x.name === cur ? -1 : y.name === cur ? 1 : x.name.localeCompare(y.name)));
  const remotes = others.filter((x) => x.kind === BranchKind.Remote).sort((x, y) => x.name.localeCompare(y.name));
  const options = [
    ...locals.map((x) => ({ value: x.name, hint: x.name === cur ? "current" : undefined })),
    ...remotes.map((x) => ({ value: x.name, hint: "remote" })),
  ];
  requestPrompt({
    title: `Compare ${head} with…`,
    message: "Pick a branch to compare against (it becomes the base).",
    placeholder: "Search branches",
    defaultValue: cur && cur !== head ? cur : "",
    confirmLabel: "Compare",
    options,
    onSubmit: (other) => {
      const base = other.trim();
      if (!base) return;
      void openCompare({ base, head, baseLabel: base, headLabel: head, scope: "branch", title: `Comparing ${head} with ${base}` });
    },
  });
}

/** Two-step prompt (name → message) for an annotated tag at `sha`. */
export function promptAnnotatedTag(
  requestPrompt: PromptFn,
  run: RunFn,
  createAnnotatedTagAt: (name: string, message: string, sha?: string) => Promise<string>,
  sha: string | undefined,
  label: string,
) {
  requestPrompt({
    title: `Create annotated tag at ${label}`,
    placeholder: "v1.0.0",
    confirmLabel: "Next",
    onSubmit: (name) =>
      requestPrompt({
        title: `Message for tag ${name}`,
        placeholder: "Tag message",
        defaultValue: name,
        confirmLabel: "Create tag",
        onSubmit: (message) => run(() => createAnnotatedTagAt(name, message, sha)),
      }),
  });
}
