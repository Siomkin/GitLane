import { fileWriteGuard } from "@/lib/advancedRepoState";
import { basename } from "@/lib/paths";
import { ClockIcon, CopyIcon, FileTextIcon, TrashIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";

export function FileContextMenu() {
  const menu = useUi((s) => s.fileMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const discardFile = useRepo((s) => s.discardFile);
  const openFileHistory = useRepo((s) => s.openFileHistory);
  const requestOpenRepoFile = useRepo((s) => s.requestOpenRepoFile);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const changes = useRepo((s) => s.changes);
  if (!menu) return null;

  const { path, dir, discard } = menu;
  const fileName = basename(path);
  const fileGuard = fileWriteGuard(
    [...changes.unstaged, ...changes.staged].find((file) => file.path === path),
    changes,
  );
  // Absolute path = repo root + repo-relative path (workdir has no trailing slash).
  const fullPath = workdir ? `${workdir.replace(/\/+$/, "")}/${path}` : path;

  // Copies close the menu with no toast — a clipboard write is instant and
  // risk-free, so a notification is pure noise (GL-217).
  const copy = (text: string) => {
    close();
    void navigator.clipboard?.writeText(text);
  };

  // A directory header (Tree view) has no file to open, no history, and nothing
  // to discard — only its path is useful, so it gets a copy-only menu.
  if (dir) {
    const dirItems: MenuItem[] = [
      { label: "Copy", header: true, icon: <CopyIcon className="h-3.5 w-3.5" /> },
      { label: "Folder name", onClick: () => copy(fileName) },
      { label: "Relative path", onClick: () => copy(path) },
      { label: "Full path", onClick: () => copy(fullPath) },
    ];
    return <MenuPanel left={menu.x} top={menu.y} items={dirItems} onClose={close} width={220} />;
  }

  // Copy is the most-used action here, so it leads — a "Copy" header labels the
  // cluster so the rows don't each repeat the word + icon. The history views are
  // tucked into a History group below.
  const items: MenuItem[] = [
    {
      label: "Open file",
      icon: <FileTextIcon className="h-4 w-4" />,
      onClick: () => { close(); requestOpenRepoFile(path); },
    },
    { label: "Copy", header: true, sep: true, icon: <CopyIcon className="h-3.5 w-3.5" /> },
    { label: "File name", onClick: () => copy(fileName) },
    { label: "Relative path", onClick: () => copy(path) },
    { label: "Full path", onClick: () => copy(fullPath) },
    {
      label: "History",
      icon: <ClockIcon className="h-4 w-4" />,
      sep: true,
      submenu: [
        { label: "File history", onClick: () => { close(); void openFileHistory(path); } },
        { label: "Blame", onClick: () => { close(); void openFileHistory(path, "blame"); } },
      ],
    },
  ];

  // Discard is a working-tree op — only offered on working-changes rows.
  if (discard) {
    const { staged } = discard;
    items.push({
      label: staged ? "Unstage & discard changes" : "Discard changes",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      disabled: !!fileGuard,
      disabledReason: fileGuard ?? undefined,
      sep: true,
      onClick: () =>
        requestConfirm({
          title: `Discard changes to ${fileName}?`,
          message:
            "The file's working-tree changes will be permanently reverted. This can't be undone.",
          confirmLabel: staged ? "Unstage & discard" : "Discard changes",
          danger: true,
          onConfirm: () => void discardFile(path, staged),
        }),
    });
  }

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={220} />;
}
