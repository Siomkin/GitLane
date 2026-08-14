import { fileWriteGuard } from "@/lib/advancedRepoState";
import type { DiscardFilePreview } from "@/lib/api";
import { basename } from "@/lib/paths";
import {
  ClockIcon,
  EditIcon,
  ExternalLinkIcon,
  FileTextIcon,
  StashIcon,
  TrashIcon,
} from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi, type FileMenu } from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";
import { uncommittedFileMenuActions } from "@/features/changes/uncommittedFileMenu";
import { previewConfirm } from "@/components/chrome/overlays/menus/previewConfirm";
import { useCopyCluster } from "./copyCluster";
import { useIgnoreSubmenu } from "./ignoreSubmenu";
import { revealLabel } from "./revealLabel";
import { lookupWorkingEntry } from "./workingEntry";

// Working-tree rows (`discard` set): ADR 0002 layout + GL-337 deferred verbs.
export function WorkingFileMenu({ menu, discard }: { menu: FileMenu; discard: { staged: boolean } }) {
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const discardFile = useRepo((s) => s.discardFile);
  const openFileHistory = useRepo((s) => s.openFileHistory);
  const requestOpenRepoFile = useRepo((s) => s.requestOpenRepoFile);
  const previewDiscardFile = useRepo((s) => s.previewDiscardFile);
  const revealInFileManager = useRepo((s) => s.revealInFileManager);
  const openPathDefault = useRepo((s) => s.openPathDefault);
  const stopTracking = useRepo((s) => s.stopTracking);
  const createWorkingTreePatch = useRepo((s) => s.createWorkingTreePatch);
  const stashFile = useRepo((s) => s.stashFile);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const changes = useRepo((s) => s.changes);
  const { path } = menu;
  const fileName = basename(path);
  const copyCluster = useCopyCluster(path);
  const ignoreSubmenu = useIgnoreSubmenu(path);

  const entry = lookupWorkingEntry(changes.unstaged, changes.staged, path, discard.staged);
  const untracked = entry?.status === "U";
  const renamed = entry?.status === "R";
  const fileGuard = fileWriteGuard(entry, changes);
  const deferred = uncommittedFileMenuActions(entry);

  const { staged } = discard;
  // Ignore… is offered on every working-tree row, staged or not — it already
  // showed on unstaged tracked rows, so gating it out of the staged bucket was
  // an inconsistency (ADR 0002 revised).
  const showIgnore = true;
  const showDiscard = !untracked && !renamed;
  const showHistory = !untracked;

  // Groups: discard · stash · ignore+tracking/patch · open+edit+delete ·
  // history · copy. Each is built independently; the panel skips empty ones.
  // Ignore shares a group with Stop tracking / Create patch — they read as one
  // "what git does with this path" block and had no divider between them.
  const discardGroup: MenuItem[] = [];
  const stashGroup: MenuItem[] = [];
  const trackingGroup: MenuItem[] = [];
  const openGroup: MenuItem[] = [];
  const historyGroup: MenuItem[] = [];

  if (showDiscard) {
    discardGroup.push({
      label: staged ? "Unstage & discard changes" : "Discard changes",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      disabled: !!fileGuard,
      disabledReason: fileGuard ?? undefined,
      onClick: () =>
        void previewConfirm<DiscardFilePreview>({
          requestConfirm,
          title: `Discard changes to ${fileName}?`,
          message:
            "The file's working-tree changes will be permanently reverted. This can't be undone.",
          confirmLabel: staged ? "Unstage & discard" : "Discard changes",
          danger: true,
          preview: () =>
            repoPath
              ? previewDiscardFile(repoPath, path, null, staged)
              : Promise.reject(new Error("No repository")),
          onConfirm: (preview) => {
            if (repoPath) {
              void discardFile(repoPath, path, null, staged, preview.expectedState);
            }
          },
        }),
    });
  }

  if (deferred.stashFile) {
    stashGroup.push({
      label: "Stash this file",
      icon: <StashIcon className="h-4 w-4" />,
      disabled: !!fileGuard,
      disabledReason: fileGuard ?? undefined,
      onClick: () => {
        close();
        requestConfirm({
          title: `Stash ${fileName}?`,
          message:
            "Only this file’s staged, unstaged, and untracked changes are stashed. Other files stay put.",
          confirmLabel: "Stash file",
          onConfirm: () => {
            void stashFile(path);
          },
        });
      },
    });
  }

  if (showIgnore) {
    trackingGroup.push({
      label: "Ignore…",
      icon: <FileTextIcon className="h-4 w-4" />,
      submenu: ignoreSubmenu(),
    });
  }

  if (deferred.stopTracking) {
    trackingGroup.push({
      label: "Stop tracking",
      icon: <TrashIcon className="h-4 w-4" />,
      // Hover-only rose — not always-red like Discard (GL-337).
      tone: "danger",
      disabled: !!fileGuard,
      disabledReason: fileGuard ?? undefined,
      onClick: () => {
        close();
        requestConfirm({
          title: `Stop tracking ${fileName}?`,
          message:
            "Git will forget this path but leave the file on disk. The removal is staged — commit to finish, or discard the staged deletion to undo. If unique staged content isn’t also on disk, Git will refuse rather than drop it.",
          confirmLabel: "Stop tracking",
          danger: true,
          onConfirm: () => {
            void stopTracking(path);
          },
        });
      },
    });
  }

  if (deferred.createPatch) {
    trackingGroup.push({
      label: "Create patch",
      icon: <FileTextIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        void createWorkingTreePatch(path);
      },
    });
  }

  // Open / Edit / Delete share one section — open-in-app, OS open, and
  // remove-from-disk are the local file verbs (GL-337). Diff Tool stays
  // out until prefs exist to configure it.
  const openSubmenu: MenuItem[] = [];
  if (deferred.openDefaultApp) {
    openSubmenu.push({
      label: "Default Application",
      onClick: () => {
        close();
        void openPathDefault(path);
      },
    });
  }
  openSubmenu.push({
    label: revealLabel,
    onClick: () => {
      close();
      void revealInFileManager(path);
    },
  });
  openGroup.push({
    label: "Open",
    icon: <ExternalLinkIcon className="h-4 w-4" />,
    submenu: openSubmenu,
  });
  if (deferred.edit) {
    openGroup.push({
      label: "Edit",
      icon: <EditIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        requestOpenRepoFile(path);
      },
    });
  }
  if (deferred.deleteFile) {
    openGroup.push({
      label: "Delete file",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      disabled: !!fileGuard,
      disabledReason: fileGuard ?? undefined,
      onClick: () =>
        void previewConfirm<DiscardFilePreview>({
          requestConfirm,
          title: `Delete ${fileName}?`,
          message: "The untracked file will be permanently removed from disk. This can't be undone.",
          confirmLabel: "Delete file",
          danger: true,
          preview: () =>
            repoPath
              ? previewDiscardFile(repoPath, path, null, staged)
              : Promise.reject(new Error("No repository")),
          onConfirm: (preview) => {
            if (repoPath) {
              void discardFile(repoPath, path, null, staged, preview.expectedState);
            }
          },
        }),
    });
  }

  if (showHistory) {
    historyGroup.push({
      label: "History",
      icon: <ClockIcon className="h-4 w-4" />,
      submenu: [
        {
          label: "File history",
          onClick: () => {
            close();
            void openFileHistory(path);
          },
        },
        {
          label: "Blame",
          onClick: () => {
            close();
            void openFileHistory(path, "blame");
          },
        },
      ],
    });
  }

  return (
    <MenuPanel
      left={menu.x}
      top={menu.y}
      groups={[
        discardGroup,
        stashGroup,
        trackingGroup,
        openGroup,
        historyGroup,
        copyCluster("file"),
      ]}
      onClose={close}
      width={240}
    />
  );
}
