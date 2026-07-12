import { api } from "@/lib/api";
import {
  fileWriteGuard,
  findGuardedFile,
  guardedAdvancedWriteMessage,
} from "@/lib/advancedRepoState";
import { CheckIcon, MinusIcon, PlusIcon, StashIcon, TrashIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "@/components/chrome/overlays/shared";
import { previewConfirm } from "./previewConfirm";

/** Right-click menu on the uncommitted "WIP" row. Acts on the whole working
 * tree; the staged/unstaged split is read from the repo store so stage/unstage
 * only appear when there's actually something in that bucket. */
export function WipContextMenu() {
  const menu = useUi((s) => s.wipMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const openCommit = useUi((s) => s.openCommit);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const changes = useRepo((s) => s.changes);
  const stageAll = useRepo((s) => s.stageAll);
  const unstageAll = useRepo((s) => s.unstageAll);
  const stash = useRepo((s) => s.stash);
  const discardAll = useRepo((s) => s.discardAll);
  const run = useBranchOp();
  if (!menu) return null;

  const hasStaged = changes.staged.length > 0;
  const hasUnstaged = changes.unstaged.length > 0;
  const stageAllGuard = fileWriteGuard(findGuardedFile(changes.unstaged, changes), changes);
  const unstageAllGuard = fileWriteGuard(findGuardedFile(changes.staged, changes), changes);
  const bulkGuard = guardedAdvancedWriteMessage(changes);

  const items: MenuItem[] = [
    { label: "Commit…", icon: <CheckIcon className="h-4 w-4" />, onClick: () => { close(); openCommit(); } },
  ];
  if (hasUnstaged) {
    items.push({
      label: "Stage all changes",
      icon: <PlusIcon className="h-4 w-4" />,
      sep: true,
      disabled: !!stageAllGuard,
      disabledReason: stageAllGuard ?? undefined,
      onClick: () => { close(); void stageAll(); },
    });
  }
  if (hasStaged) {
    items.push({
      label: "Unstage all changes",
      icon: <MinusIcon className="h-4 w-4" />,
      sep: !hasUnstaged,
      disabled: !!unstageAllGuard,
      disabledReason: unstageAllGuard ?? undefined,
      onClick: () => { close(); void unstageAll(); },
    });
  }
  items.push({
    label: "Stash all changes",
    icon: <StashIcon className="h-4 w-4" />,
    sep: true,
    disabled: !!bulkGuard,
    disabledReason: bulkGuard ?? undefined,
    onClick: () => { close(); void stash(); },
  });
  items.push({
    label: "Discard all changes",
    icon: <TrashIcon className="h-4 w-4" />,
    danger: true,
    disabled: !!bulkGuard,
    disabledReason: bulkGuard ?? undefined,
    sep: true,
    onClick: () =>
      void previewConfirm({
        requestConfirm,
        title: "Discard all changes?",
        message:
          "Every uncommitted change — staged, unstaged, and untracked files — will be permanently discarded. This can't be undone.",
        confirmLabel: "Discard all",
        danger: true,
        preview: () =>
          repoPath
            ? api.previewDiscardAll(repoPath)
            : Promise.reject(new Error("No repository")),
        onConfirm: () => void run(() => discardAll()),
      }),
  });

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={208} />;
}
