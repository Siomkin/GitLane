import { fileWriteGuard } from "@/lib/advancedRepoState";
import type { DiscardFilePreview, FileChange } from "@/lib/api";
import { basename } from "@/lib/paths";
import { isMac, isWindows } from "@/lib/platform";
import {
  ClockIcon,
  CopyIcon,
  FileTextIcon,
  FolderIcon,
  RefreshIcon,
  TrashIcon,
} from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";
import { anchoredIgnorePath, ignorePatternChoices } from "@/features/changes/ignorePatterns";
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

  const copyCluster = (kind: "file" | "folder"): MenuItem[] => [
    { label: "Copy", header: true, sep: true, icon: <CopyIcon className="h-3.5 w-3.5" /> },
    { label: kind === "folder" ? "Folder name" : "File name", onClick: () => copy(fileName) },
    { label: "Relative path", onClick: () => copy(path) },
    { label: "Full path", onClick: () => copy(fullPath) },
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
    const dirItems: MenuItem[] = [];
    if (working) {
      dirItems.push({
        label: "Ignore folder…",
        icon: <FileTextIcon className="h-4 w-4" />,
        submenu: ignoreSubmenu({ dir: true }),
      });
    }
    dirItems.push({
      label: revealLabel,
      icon: <FolderIcon className="h-4 w-4" />,
      sep: working,
      onClick: () => {
        close();
        void revealInFileManager(path);
      },
    });
    dirItems.push(...copyCluster("folder"));
    return <MenuPanel left={menu.x} top={menu.y} items={dirItems} onClose={close} width={240} />;
  }

  const entry = lookupWorkingEntry(changes.unstaged, changes.staged, path, discard?.staged);
  const untracked = entry?.status === "U";
  const renamed = entry?.status === "R";
  const fileGuard = fileWriteGuard(entry, changes);

  // Working-tree rows (`discard` set): ADR 0002 layout.
  if (discard) {
    const { staged } = discard;
    const showIgnore = !staged;
    const showDiscard = !untracked && !renamed;
    const showDelete = untracked;
    const showHistory = !untracked;

    const items: MenuItem[] = [];

    if (showDiscard) {
      items.push({
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

    if (showDelete) {
      items.push({
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

    if (showIgnore) {
      items.push({
        label: "Ignore…",
        icon: <FileTextIcon className="h-4 w-4" />,
        sep: items.length > 0,
        submenu: ignoreSubmenu(),
      });
    }

    items.push(
      {
        label: "Open file",
        icon: <FileTextIcon className="h-4 w-4" />,
        sep: true,
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
    );

    if (showHistory) {
      items.push({
        label: "History",
        icon: <ClockIcon className="h-4 w-4" />,
        sep: true,
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

    items.push(...copyCluster("file"));
    return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={240} />;
  }

  // Committed file menu (ADR 0003): Restore… then open / reveal / history / copy.
  const items: MenuItem[] = [];
  if (restore) {
    const { commitOid } = restore;
    const shortOid = commitOid.slice(0, 7);
    items.push({
      label: "Restore from this commit…",
      icon: <RefreshIcon className="h-4 w-4" />,
      danger: true,
      onClick: () => {
        close();
        void (async () => {
          try {
            const wouldChange = await worktreeDiffersFromCommit(commitOid, path);
            if (!wouldChange) {
              await restorePathFromCommit(commitOid, path);
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
  items.push(
    {
      label: "Open file",
      icon: <FileTextIcon className="h-4 w-4" />,
      sep: items.length > 0,
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
    {
      label: "History",
      icon: <ClockIcon className="h-4 w-4" />,
      sep: true,
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
    ...copyCluster("file"),
  );

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={240} />;
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
