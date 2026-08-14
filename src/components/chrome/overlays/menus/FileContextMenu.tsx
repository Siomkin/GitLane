import { useUi, fileMenuOf } from "@/store/ui";
import { CommittedFileMenu } from "./file-context-menu/CommittedFileMenu";
import { DirectoryFileMenu } from "./file-context-menu/DirectoryFileMenu";
import { WorkingFileMenu } from "./file-context-menu/WorkingFileMenu";

/** Dispatches the open file menu to its variant: Tree-view directory header,
 * working-tree row, or committed file. */
export function FileContextMenu() {
  const menu = useUi(fileMenuOf);
  if (!menu) return null;
  if (menu.dir) return <DirectoryFileMenu menu={menu} />;
  if (menu.discard) return <WorkingFileMenu menu={menu} discard={menu.discard} />;
  return <CommittedFileMenu menu={menu} />;
}
