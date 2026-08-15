import { useUi, fileMenuOf, FileMenuKind } from "@/store/ui";
import { CommittedFileMenu } from "./file-context-menu/CommittedFileMenu";
import { DirectoryFileMenu } from "./file-context-menu/DirectoryFileMenu";
import { WorkingFileMenu } from "./file-context-menu/WorkingFileMenu";

/** Dispatches the open file menu to its variant — Tree-view directory header,
 * working-tree row, or committed file — by its `kind` discriminant. */
export function FileContextMenu() {
  const menu = useUi(fileMenuOf);
  if (!menu) return null;
  switch (menu.kind) {
    case FileMenuKind.Directory:
      return <DirectoryFileMenu menu={menu} />;
    case FileMenuKind.Working:
      return <WorkingFileMenu menu={menu} />;
    case FileMenuKind.Committed:
      return <CommittedFileMenu menu={menu} />;
  }
}
