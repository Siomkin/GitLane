import { FileTextIcon, FolderIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi, FileMenuKind, type FileMenu } from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";
import { useCopyCluster } from "./copyCluster";
import { useIgnoreSubmenu } from "./ignoreSubmenu";
import { revealLabel } from "./revealLabel";

// Directory header (Tree view): Ignore folder on working-tree dirs; otherwise
// Reveal + Copy (ADR 0003 committed dirs — no recursive Restore).
export function DirectoryFileMenu({
  menu,
}: {
  menu: Extract<FileMenu, { kind: typeof FileMenuKind.Directory }>;
}) {
  const close = useUi((s) => s.closeOverlays);
  const revealInFileManager = useRepo((s) => s.revealInFileManager);
  const { path, working } = menu;
  const copyCluster = useCopyCluster(path);
  const ignoreSubmenu = useIgnoreSubmenu(path);

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
