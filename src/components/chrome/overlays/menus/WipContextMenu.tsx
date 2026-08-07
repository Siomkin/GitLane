import {
  discardAllGuardMessage,
  fileWriteGuard,
  findGuardedFile,
  guardedAdvancedWriteMessage,
} from "@/lib/advancedRepoState";
import { CheckIcon, MinusIcon, PlusIcon, StashIcon, TrashIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";
import { useDiscardAllChanges } from "./useDiscardAllChanges";

/** Right-click menu on the uncommitted "WIP" row. Acts on the whole working
 * tree; the staged/unstaged split is read from the repo store so stage/unstage
 * only appear when there's actually something in that bucket. */
export function WipContextMenu() {
  const menu = useUi((s) => s.wipMenu);
  const close = useUi((s) => s.closeOverlays);
  const openCommit = useUi((s) => s.openCommit);
  const summary = useRepo((s) => s.summary);
  const repoPath = summary?.path ?? null;
  const changes = useRepo((s) => s.changes);
  const stageAll = useRepo((s) => s.stageAll);
  const unstageAll = useRepo((s) => s.unstageAll);
  const stash = useRepo((s) => s.stash);
  const discardAllChanges = useDiscardAllChanges(repoPath);
  if (!menu) return null;

  const hasStaged = changes.staged.length > 0;
  const hasUnstaged = changes.unstaged.length > 0;
  const stageAllGuard = fileWriteGuard(findGuardedFile(changes.unstaged, changes), changes);
  const unstageAllGuard = fileWriteGuard(findGuardedFile(changes.staged, changes), changes);
  const bulkGuard = guardedAdvancedWriteMessage(changes);
  const discardGuard = discardAllGuardMessage(changes, summary?.unborn === true);

  // Groups: commit · stage/unstage · stash · discard. An absent bulk row simply
  // leaves its group empty; the panel skips it rather than the menu having to
  // work out who now owns the boundary.
  const staging: MenuItem[] = [];
  if (hasUnstaged) {
    staging.push({
      label: "Stage all changes",
      icon: <PlusIcon className="h-4 w-4" />,
      disabled: !!stageAllGuard,
      disabledReason: stageAllGuard ?? undefined,
      onClick: () => { close(); void stageAll(); },
    });
  }
  if (hasStaged) {
    staging.push({
      label: "Unstage all changes",
      icon: <MinusIcon className="h-4 w-4" />,
      disabled: !!unstageAllGuard,
      disabledReason: unstageAllGuard ?? undefined,
      onClick: () => { close(); void unstageAll(); },
    });
  }
  const groups: MenuItem[][] = [
    [{ label: "Commit…", icon: <CheckIcon className="h-4 w-4" />, onClick: () => { close(); openCommit(); } }],
    staging,
    [{
      label: "Stash all changes",
      icon: <StashIcon className="h-4 w-4" />,
      disabled: !!bulkGuard,
      disabledReason: bulkGuard ?? undefined,
      onClick: () => { close(); void stash(); },
    }],
    [{
      label: "Discard all changes",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      disabled: !!discardGuard,
      disabledReason: discardGuard ?? undefined,
      onClick: discardAllChanges,
    }],
  ];

  return <MenuPanel left={menu.x} top={menu.y} groups={groups} onClose={close} width={208} />;
}
