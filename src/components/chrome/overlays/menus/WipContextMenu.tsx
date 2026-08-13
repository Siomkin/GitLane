import {
  discardAllGuardMessage,
  fileWriteGuard,
  findGuardedFile,
  guardedAdvancedWriteMessage,
} from "@/lib/advancedRepoState";
import { ShortcutId } from "@/lib/shortcuts";
import { AiActionScopeKind, scopeFromSelection } from "@/features/agents/ai-actions";
import { CheckIcon, MinusIcon, PlusIcon, SparkleIcon, StashIcon, TrashIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi, wipMenuOf } from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";
import { useDiscardAllChanges } from "./useDiscardAllChanges";

/** Right-click menu on the uncommitted "WIP" row. Acts on the whole working
 * tree; the staged/unstaged split is read from the repo store so stage/unstage
 * only appear when there's actually something in that bucket. */
export function WipContextMenu() {
  const menu = useUi(wipMenuOf);
  const close = useUi((s) => s.closeOverlays);
  const openCommit = useUi((s) => s.openCommit);
  const openAiActions = useUi((s) => s.openAiActions);
  const summary = useRepo((s) => s.summary);
  const repoPath = summary?.path ?? null;
  const changes = useRepo((s) => s.changes);
  const selectedCommits = useRepo((s) => s.selectedCommits);
  const wipSelected = useRepo((s) => s.wipSelected);
  const selectionDiff = useRepo((s) => s.selectionDiff);
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
    [{
      label: "AI actions…",
      icon: <SparkleIcon className="h-4 w-4 text-[color:var(--accent)]" />,
      shortcut: ShortcutId.AiActions,
      // Right-clicking the WIP row does not select it, so an earlier commit
      // selection is still in the store. Carry it only when WIP is genuinely
      // part of that selection; otherwise this menu is about WIP alone.
      onClick: () =>
        openAiActions(
          // The WIP row is always in scope here; only the commits are in doubt.
          scopeFromSelection({
            selectedCommits: wipSelected ? selectedCommits : [],
            selectedCommit: null,
            wipSelected: true,
            workingBase: selectionDiff?.workingBase ?? null,
          }) ?? { kind: AiActionScopeKind.Working },
        ),
    }],
    staging,
    [{
      label: "Stash all changes",
      icon: <StashIcon className="h-4 w-4" />,
      shortcut: ShortcutId.Stash,
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

  return <MenuPanel left={menu.x} top={menu.y} groups={groups} onClose={close} width={240} />;
}
