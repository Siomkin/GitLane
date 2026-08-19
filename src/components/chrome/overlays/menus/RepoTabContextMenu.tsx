import { cn } from "@/lib/cn";
import { repoLabel } from "@/lib/paths";
import { tabIdentity } from "@/lib/tabs";
import { CloseIcon, EditIcon, FolderIcon, MinusIcon, PlusIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { repoGroupColorStyles, repoGroupOf, repoNameOf, useUi, repoTabMenuOf } from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";

/** Right-click menu on a repository tab: what the tab is *called* and which
 * group it belongs to — the two things that tell apart three repositories all
 * checked out into a folder named `frontend`.
 *
 * Both act on the repository *identity* (a worktree tab edits its parent
 * repository), so renaming from any of a repo's tabs renames all of them.
 *
 * Scoped to the repository: what happens to the *group* as a whole (collapse,
 * rename, delete) belongs to `RepoGroupContextMenu`, raised by right-clicking
 * the group itself. Only "Remove from group" lives here, because its subject
 * is this one repository. */
export function RepoTabContextMenu() {
  const menu = useUi(repoTabMenuOf);
  const close = useUi((s) => s.closeOverlays);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const repoGroups = useUi((s) => s.repoGroups);
  const repoLabelsByIdentity = useUi((s) => s.repoLabelsByIdentity);
  const setRepoName = useUi((s) => s.setRepoName);
  const createRepoGroup = useUi((s) => s.createRepoGroup);
  const assignRepoGroup = useUi((s) => s.assignRepoGroup);
  const tabInfoByPath = useRepo((s) => s.tabInfoByPath);
  const closeRepo = useRepo((s) => s.closeRepo);
  if (!menu) return null;

  const { path } = menu;
  const labels = { repoGroups, repoLabelsByIdentity };
  const identity = tabIdentity(path, tabInfoByPath[path]);
  const customName = repoNameOf(labels, identity);
  const group = repoGroupOf(labels, identity);
  const folderName = repoLabel(identity);

  const rename: MenuItem[] = [{
    label: "Rename…",
    icon: <EditIcon className="h-4 w-4" />,
    onClick: () =>
      requestPrompt({
        title: `Rename ${folderName}`,
        message: "Shown on this repository's tabs and in Recent repositories.",
        placeholder: folderName,
        defaultValue: customName ?? folderName,
        confirmLabel: "Rename",
        // The prompt only fires on a non-empty value, so clearing a name is a
        // deliberate second action rather than a silently ignored empty submit.
        onSubmit: (name) => setRepoName(identity, name),
      }),
  }];
  if (customName) {
    rename.push({
      label: "Use folder name",
      icon: <FolderIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        setRepoName(identity, null);
      },
    });
  }

  // Assignment offers every group except the one it is already in, plus a
  // create-and-assign row — so grouping a repo is always one menu away.
  const assign: MenuItem[] = repoGroups
    .filter((g) => g.id !== group?.id)
    .map((g) => ({
      label: g.name,
      icon: (
        <span
          aria-hidden="true"
          className={cn("h-2.5 w-2.5 rounded-full", repoGroupColorStyles[g.color].dot)}
        />
      ),
      onClick: () => {
        close();
        assignRepoGroup(identity, g.id);
      },
    }));
  assign.push({
    label: "New group…",
    icon: <PlusIcon className="h-4 w-4" />,
    onClick: () =>
      requestPrompt({
        title: "New group",
        message: `Create a group and put ${customName ?? folderName} in it.`,
        placeholder: "Acme",
        confirmLabel: "Create group",
        onSubmit: (name) => assignRepoGroup(identity, createRepoGroup(name)),
      }),
  });

  const groupRows: MenuItem[] = [{
    label: group ? `Group: ${group.name}` : "Assign to group",
    icon: group ? (
      <span
        aria-hidden="true"
        className={cn("h-2.5 w-2.5 rounded-full", repoGroupColorStyles[group.color].dot)}
      />
    ) : (
      <FolderIcon className="h-4 w-4" />
    ),
    submenu: assign,
  }];
  if (group) {
    groupRows.push({
      label: "Remove from group",
      icon: <MinusIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        assignRepoGroup(identity, null);
      },
    });
  }

  const tab: MenuItem[] = [{
    label: "Close tab",
    icon: <CloseIcon className="h-3 w-3" />,
    onClick: () => {
      close();
      void closeRepo(path);
    },
  }];

  const heading = (
    <div className="flex w-full min-w-0 flex-col gap-0.5">
      <span className="truncate text-[12px] font-medium text-neutral-800 dark:text-neutral-100">
        {customName ?? folderName}
      </span>
      <span className="truncate font-mono text-[10.5px] text-neutral-400 dark:text-neutral-500">
        {identity}
      </span>
    </div>
  );

  return (
    <MenuPanel
      left={menu.x}
      top={menu.y}
      groups={[rename, groupRows, tab]}
      onClose={close}
      width={230}
      heading={heading}
    />
  );
}
