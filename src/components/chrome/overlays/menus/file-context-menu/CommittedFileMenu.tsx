import { ClockIcon, FileTextIcon, FolderIcon, RefreshIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi, FileMenuKind, type FileMenu } from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";
import { useCopyCluster } from "./copyCluster";
import { revealLabel } from "./revealLabel";

// Committed file menu (ADR 0003): Restore… then open / reveal / history / copy.
export function CommittedFileMenu({
  menu,
}: {
  menu: Extract<FileMenu, { kind: typeof FileMenuKind.Committed }>;
}) {
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const showToast = useUi((s) => s.showToast);
  const openFileHistory = useRepo((s) => s.openFileHistory);
  const requestOpenRepoFile = useRepo((s) => s.requestOpenRepoFile);
  const revealInFileManager = useRepo((s) => s.revealInFileManager);
  const worktreeDiffersFromCommit = useRepo((s) => s.worktreeDiffersFromCommit);
  const restorePathFromCommit = useRepo((s) => s.restorePathFromCommit);
  const { path, restore } = menu;
  const copyCluster = useCopyCluster(path);

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
