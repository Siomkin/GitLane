import { CompareIcon, PlusIcon } from "@/components/ui/icons";
import { type MenuItem } from "@/components/chrome/overlays/shared";
import {
  promptAnnotatedTag,
  promptCompareBranch,
  promptCreateWorktree,
} from "@/components/chrome/overlays/menus/prompts";
import type { BranchMenuContext } from "./context";

// ---- create: branch creation is a flat row; the rarer create targets and the
// compare variants fold into their own submenus. ----
export function createItems(ctx: BranchMenuContext): MenuItem[] {
  const {
    b,
    cur,
    tip,
    tipShort,
    upstream,
    workdir,
    branches,
    act,
    close,
    run,
    requestPrompt,
    worktreeCheckedOut: wtCheckedOut,
    worktreeRef: wtRef,
    openCreateBranchFrom,
    openCompare,
    createPatchAt,
    createTagAt,
    createAnnotatedTagAt,
    createWorktreeAt,
  } = ctx;

  const create: MenuItem[] = [
    { label: "Create branch here…", icon: <PlusIcon className="h-4 w-4" />, onClick: () => openCreateBranchFrom(b) },
  ];
  {
    const createChildren: MenuItem[] = [];
    if (tip) {
      createChildren.push({
        label: "Tag here…",
        onClick: () => requestPrompt({ title: `Create tag at ${tipShort}`, placeholder: "v1.0.0", confirmLabel: "Create tag", onSubmit: (name) => void run(() => createTagAt(name, tip)) }),
      });
      createChildren.push({ label: "Annotated tag here…", onClick: () => promptAnnotatedTag(requestPrompt, run, createAnnotatedTagAt, tip, b) });
    }
    // Worktree *creation* is a create verb; managing an existing worktree lives
    // on the worktree pill / navigator row (the single home). When the branch is
    // already checked out in a linked worktree, git refuses a second checkout,
    // so create detached at the tip and say so in the prompt.
    createChildren.push({
      label: "New worktree here…",
      onClick: () =>
        promptCreateWorktree(requestPrompt, run, createWorktreeAt, wtRef, workdir, b, {
          detachedAt: wtCheckedOut && tipShort ? tipShort : undefined,
        }),
    });
    if (tip) createChildren.push({ label: "Patch from commit", onClick: () => act(() => createPatchAt(tip)) });
    create.push({ label: "Create", submenu: createChildren });
  }
  if (tip) {
    const compareChildren: MenuItem[] = [];
    if (upstream) {
      compareChildren.push({
        label: "Compare with upstream",
        onClick: () => { close(); void openCompare({ base: upstream, head: b, baseLabel: upstream, headLabel: b, scope: "upstream", title: `Comparing ${b} with ${upstream}` }); },
      });
    }
    compareChildren.push({
      label: "Compare with branch…",
      onClick: () => promptCompareBranch(requestPrompt, openCompare, branches, b, cur),
    });
    create.push({ label: "Compare", icon: <CompareIcon className="h-4 w-4" />, submenu: compareChildren });
  }
  return create;
}
