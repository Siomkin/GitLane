import { cn } from "@/lib/cn";
import { ChevronDownIcon, ChevronRightIcon, EditIcon, TrashIcon } from "@/components/ui/icons";
import {
  repoGroupCollapsed,
  repoGroupColorStyles,
  repoGroupMenuOf,
  useUi,
} from "@/store/ui";
import { MenuPanel, type MenuItem } from "@/components/chrome/overlays/shared";

/** Right-click menu on a repository group in the title-bar strip — its name in
 * the well, or its collapsed pill.
 *
 * Split from `RepoTabContextMenu` because the subjects differ: everything here
 * acts on the group as a whole, while the tab menu acts on one repository. It
 * is also the only menu a collapsed group has, since its members' tabs are
 * folded away and there is nothing else left to right-click. */
export function RepoGroupContextMenu() {
  const menu = useUi(repoGroupMenuOf);
  const close = useUi((s) => s.closeOverlays);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const repoGroups = useUi((s) => s.repoGroups);
  const collapsedRepoGroups = useUi((s) => s.collapsedRepoGroups);
  const renameRepoGroup = useUi((s) => s.renameRepoGroup);
  const deleteRepoGroup = useUi((s) => s.deleteRepoGroup);
  const toggleRepoGroupCollapsed = useUi((s) => s.toggleRepoGroupCollapsed);
  if (!menu) return null;

  const group = repoGroups.find((g) => g.id === menu.groupId);
  // The group can be deleted from elsewhere while its menu is up; a menu with
  // no subject renders nothing rather than an empty panel.
  if (!group) return null;
  const collapsed = repoGroupCollapsed({ repoGroups, collapsedRepoGroups }, group.id);

  const rows: MenuItem[] = [
    {
      label: collapsed ? "Expand group" : "Collapse group",
      icon: collapsed ? (
        <ChevronRightIcon className="h-4 w-4" />
      ) : (
        <ChevronDownIcon className="h-4 w-4" />
      ),
      onClick: () => {
        close();
        toggleRepoGroupCollapsed(group.id);
      },
    },
    {
      label: "Rename group…",
      icon: <EditIcon className="h-4 w-4" />,
      onClick: () =>
        requestPrompt({
          title: `Rename ${group.name}`,
          placeholder: group.name,
          defaultValue: group.name,
          confirmLabel: "Rename group",
          onSubmit: (name) => renameRepoGroup(group.id, name),
        }),
    },
  ];

  const destructive: MenuItem[] = [
    {
      label: "Delete group",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      onClick: () => {
        close();
        // Only the grouping is deleted — no repository, name, or tab goes with
        // it, so this needs no confirm step.
        deleteRepoGroup(group.id);
      },
    },
  ];

  const heading = (
    <div className="flex w-full min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className={cn("h-2.5 w-2.5 shrink-0 rounded-full", repoGroupColorStyles[group.color].dot)}
      />
      <span className="truncate text-[12px] font-medium text-neutral-800 dark:text-neutral-100">
        {group.name}
      </span>
    </div>
  );

  return (
    <MenuPanel
      left={menu.x}
      top={menu.y}
      groups={[rows, destructive]}
      onClose={close}
      width={210}
      heading={heading}
    />
  );
}
