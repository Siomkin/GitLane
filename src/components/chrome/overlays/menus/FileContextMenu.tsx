import { fileWriteGuard } from "@/lib/advancedRepoState";
import type { DiscardFilePreview, FileChange } from "@/lib/api";
import { basename } from "@/lib/paths";
import { isMac, isWindows } from "@/lib/platform";
import {
  ClockIcon,
  CopyIcon,
  EditIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderIcon,
  RefreshIcon,
  StashIcon,
  TrashIcon,
} from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";
import { anchoredIgnorePath, ignorePatternChoices } from "@/features/changes/ignorePatterns";
import { uncommittedFileMenuActions } from "@/features/changes/uncommittedFileMenu";
import { previewConfirm } from "./previewConfirm";

const revealLabel = isMac ? "Show in Finder" : isWindows ? "Show in Explorer" : "Show in file manager";

export function FileContextMenu() {
  const menu = useUi((s) => s.fileMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const showToast = useUi((s) => s.showToast);
  const discardFile = useRepo((s) => s.discardFile);
  const openFileHistory = useRepo((s) => s.openFileHistory);
  const requestOpenRepoFile = useRepo((s) => s.requestOpenRepoFile);
  const previewDiscardFile = useRepo((s) => s.previewDiscardFile);
  const appendIgnorePattern = useRepo((s) => s.appendIgnorePattern);
  const revealInFileManager = useRepo((s) => s.revealInFileManager);
  const openPathDefault = useRepo((s) => s.openPathDefault);
  const stopTracking = useRepo((s) => s.stopTracking);
  const createWorkingTreePatch = useRepo((s) => s.createWorkingTreePatch);
  const stashFile = useRepo((s) => s.stashFile);
  const worktreeDiffersFromCommit = useRepo((s) => s.worktreeDiffersFromCommit);
  const restorePathFromCommit = useRepo((s) => s.restorePathFromCommit);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const changes = useRepo((s) => s.changes);
  if (!menu) return null;

  const { path, dir, discard, restore, working } = menu;
  const fileName = basename(path);
  // Absolute path = repo root + repo-relative path (workdir has no trailing slash).
  const fullPath = workdir ? `${workdir.replace(/\/+$/, "")}/${path}` : path;

  const copy = (text: string) => {
    close();
    void navigator.clipboard?.writeText(text);
  };

  // The copy options carry no glyph of their own; reserve the same icon column
  // (w-4 + gap) so their labels align with the icon'd action rows above rather
  // than sitting flush against the panel's left padding.
  const copyIndent = <span className="block h-4 w-4" aria-hidden />;
  // Its own group everywhere it appears — the panel puts the divider above it.
  const copyCluster = (kind: "file" | "folder"): MenuItem[] => [
    { label: "Copy", header: true, icon: <CopyIcon className="h-3.5 w-3.5" /> },
    { label: kind === "folder" ? "Folder name" : "File name", icon: copyIndent, onClick: () => copy(fileName) },
    { label: "Relative path", icon: copyIndent, onClick: () => copy(path) },
    { label: "Full path", icon: copyIndent, onClick: () => copy(fullPath) },
  ];

  const applyIgnore = (pattern: string, local: boolean) => {
    close();
    void appendIgnorePattern(pattern, local);
  };

  const ignoreSubmenu = (opts?: { dir?: boolean }): MenuItem[] => {
    const items: MenuItem[] = ignorePatternChoices(path, opts).map((choice) => ({
      label: choice.label,
      onClick: () => applyIgnore(choice.pattern, choice.local),
    }));
    const customDefault = opts?.dir ? `${anchoredIgnorePath(path)}/` : fileName;
    items.push({
      label: "Custom pattern…",
      onClick: () =>
        requestPrompt({
          title: "Ignore pattern",
          message: "Appended to the repository’s root .gitignore.",
          placeholder: "*.log",
          confirmLabel: "Ignore",
          defaultValue: customDefault,
          onSubmit: (pattern) => {
            void appendIgnorePattern(pattern, false);
          },
        }),
    });
    return items;
  };

  // Directory header (Tree view): Ignore folder on working-tree dirs; otherwise
  // Reveal + Copy (ADR 0003 committed dirs — no recursive Restore).
  if (dir) {
    const ignore: MenuItem[] = [];
    if (working) {
      ignore.push({
        label: "Ignore folder…",
        icon: <FileTextIcon className="h-4 w-4" />,
        submenu: ignoreSubmenu({ dir: true }),
      });
    }
    const reveal: MenuItem[] = [{
      label: revealLabel,
      icon: <FolderIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        void revealInFileManager(path);
      },
    }];
    return (
      <MenuPanel
        left={menu.x}
        top={menu.y}
        groups={[ignore, reveal, copyCluster("folder")]}
        onClose={close}
        width={240}
      />
    );
  }

  const entry = lookupWorkingEntry(changes.unstaged, changes.staged, path, discard?.staged);
  const untracked = entry?.status === "U";
  const renamed = entry?.status === "R";
  const fileGuard = fileWriteGuard(entry, changes);
  const deferred = uncommittedFileMenuActions(entry);

  // Working-tree rows (`discard` set): ADR 0002 layout + GL-337 deferred verbs.
  if (discard) {
    const { staged } = discard;
    // Ignore… is offered on every working-tree row, staged or not — it already
    // showed on unstaged tracked rows, so gating it out of the staged bucket was
    // an inconsistency (ADR 0002 revised).
    const showIgnore = true;
    const showDiscard = !untracked && !renamed;
    const showHistory = !untracked;

    // Groups: discard · stash · ignore · tracking/patch · open+edit+delete ·
    // history · copy. Each is built independently; the panel skips empty ones.
    const discardGroup: MenuItem[] = [];
    const stashGroup: MenuItem[] = [];
    const ignoreGroup: MenuItem[] = [];
    const items: MenuItem[] = [];
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
      ignoreGroup.push({
        label: "Ignore…",
        icon: <FileTextIcon className="h-4 w-4" />,
        submenu: ignoreSubmenu(),
      });
    }

    if (deferred.stopTracking) {
      items.push({
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
      items.push({
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
          ignoreGroup,
          items,
          openGroup,
          historyGroup,
          copyCluster("file"),
        ]}
        onClose={close}
        width={240}
      />
    );
  }

  // Committed file menu (ADR 0003): Restore… then open / reveal / history / copy.
  const restoreGroup: MenuItem[] = [];
  if (restore) {
    const { commitOid } = restore;
    const shortOid = commitOid.slice(0, 7);
    restoreGroup.push({
      label: "Restore from this commit…",
      icon: <RefreshIcon className="h-4 w-4" />,
      danger: true,
      onClick: () => {
        close();
        void (async () => {
          try {
            const wouldChange = await worktreeDiffersFromCommit(commitOid, path);
            if (!wouldChange) {
              // The worktree already matches the commit blob, so restoring would
              // rewrite identical bytes — skip the write and say so. This one
              // stays loud: the early return happens *before* the confirm
              // dialog, so silence would make the menu item look broken.
              showToast(`${path} already matches ${shortOid}`);
              return;
            }
            requestConfirm({
              title: `Restore ${path}?`,
              message: `Replace the on-disk file with the version from ${shortOid}. Local edits to this path will be lost.`,
              confirmLabel: "Restore",
              danger: true,
              onConfirm: () => {
                void restorePathFromCommit(commitOid, path);
              },
            });
          } catch (error) {
            showToast(String(error), "error");
          }
        })();
      },
    });
  }
  const openGroup: MenuItem[] = [
    {
      label: "Open file",
      icon: <FileTextIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        requestOpenRepoFile(path);
      },
    },
    {
      label: revealLabel,
      icon: <FolderIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        void revealInFileManager(path);
      },
    },
  ];
  const historyGroup: MenuItem[] = [
    {
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
    },
  ];

  return (
    <MenuPanel
      left={menu.x}
      top={menu.y}
      groups={[restoreGroup, openGroup, historyGroup, copyCluster("file")]}
      onClose={close}
      width={240}
    />
  );
}

function lookupWorkingEntry(
  unstaged: FileChange[],
  staged: FileChange[],
  path: string,
  stagedBucket: boolean | undefined,
): FileChange | undefined {
  if (stagedBucket === true) return staged.find((file) => file.path === path);
  if (stagedBucket === false) return unstaged.find((file) => file.path === path);
  return unstaged.find((file) => file.path === path) ?? staged.find((file) => file.path === path);
}
