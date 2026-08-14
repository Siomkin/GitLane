import { defaultPublishTarget } from "@/lib/branchSync";
import { ShortcutId } from "@/lib/shortcuts";
import {
  CheckIcon,
  FolderIcon,
  HashIcon,
  PullIcon,
  PullRequestIcon,
  PushIcon,
} from "@/components/ui/icons";
import { type MenuItem } from "@/components/chrome/overlays/shared";
import type { BranchMenuContext } from "./context";

// ---- everyday actions (lead the menu) ----
export function quickActionItems(ctx: BranchMenuContext): MenuItem[] {
  const {
    b,
    act,
    close,
    run,
    requestPrompt,
    branches,
    info,
    upstream,
    needsPublishPrompt,
    isCurrent,
    isLocal,
    isRemote,
    existingWorktree: existingWt,
    remoteCheckout,
    remoteCheckoutHasLocal,
    prsUnsupported,
    pull,
    push,
    pushBranch,
    publishBranch,
    openWorktree,
    checkoutBranch,
    checkoutRemoteBranch,
    openCreatePr,
  } = ctx;

  const promptPublishBranch = () =>
    requestPrompt({
      title: `Publish ${b}`,
      message: `Remote branch for ${b} to push to and pull from.`,
      placeholder: "origin/branch",
      defaultValue: defaultPublishTarget(branches, b, upstream, info?.sync?.status !== "staleUpstream"),
      confirmLabel: "Publish",
      onSubmit: (up) => void run(() => publishBranch(b, up)),
    });
  const pushLocalBranch = () => {
    if (needsPublishPrompt) {
      promptPublishBranch();
      return;
    }
    act(() => pushBranch(b));
  };

  const top: MenuItem[] = [];
  if (isLocal && isCurrent) {
    top.push({
      label: "Pull (fast-forward only)",
      icon: <PullIcon className="h-4 w-4" />,
      shortcut: ShortcutId.Pull,
      onClick: () => { close(); void pull(); },
    });
    top.push({
      label: "Push",
      icon: <PushIcon className="h-4 w-4" />,
      shortcut: ShortcutId.Push,
      onClick: needsPublishPrompt ? promptPublishBranch : () => { close(); void push(); },
    });
  } else if (isLocal) {
    top.push({ label: `Push ${b}`, icon: <PushIcon className="h-4 w-4" />, onClick: pushLocalBranch });
  }
  // Open worktree stays a promoted one-click; the rest of worktree management is
  // grouped in the Worktree fan below.
  if (existingWt) {
    top.push({
      label: "Open worktree",
      icon: <FolderIcon className="h-4 w-4 text-[color:var(--accent)]" />,
      onClick: () => { close(); void openWorktree(existingWt.path); },
    });
  }
  if (!isCurrent && !existingWt) {
    top.push({
      label: remoteCheckout ? `Checkout ${remoteCheckout.branch}` : isRemote ? `Checkout ${b} (detached)` : `Checkout ${b}`,
      icon: <CheckIcon className="h-4 w-4" />,
      onClick: remoteCheckout
        ? () => act(() => checkoutRemoteBranch(remoteCheckout.remote, remoteCheckout.branch))
        : () => act(() => checkoutBranch(b)),
    });
    if (isRemote && remoteCheckoutHasLocal) {
      top.push({
        label: `Checkout ${b} detached`,
        icon: <HashIcon className="h-4 w-4" />,
        onClick: () => act(() => checkoutBranch(b)),
      });
    }
  }
  // Last of the everyday verbs: a pull request opens *from* this branch, so it
  // is offered on any local branch rather than only the checked-out one —
  // `gh pr create --head` does not require a checkout either. It sits below
  // Checkout because checking out is the commoner thing to want on a branch
  // you are pointing at. An unpublished branch still qualifies: that is the
  // state you are in most often when you want a pull request, and the form
  // publishes before it creates. Hidden only on a forge with no pull requests;
  // an unknown forge (still detecting) counts as capable, matching the PR
  // list's own gate.
  if (isLocal && !prsUnsupported) {
    top.push({
      label: "Open a pull request…",
      icon: <PullRequestIcon className="h-4 w-4" />,
      onClick: () => openCreatePr(b),
    });
  }
  return top;
}
