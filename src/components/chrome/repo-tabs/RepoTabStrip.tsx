import { useCallback } from "react";
import { DragDropProvider, type DragEndEvent } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { groupRuns, moveRun, moveWithinRun, runKey, tabDisplay, tabIdentity } from "@/lib/tabs";
import { useRepo } from "@/store/repo";
import { MenuKind, repoGroupCollapsed, repoGroupOf, repoNameOf, useUi } from "@/store/ui";
import { RepoTabRun, type RunTabProps } from "./RepoTabRun";

/** The open-repository tabs, drawn in group runs (GL — repo groups): each
 * group's tabs together inside its bordered cluster, ungrouped tabs on their
 * own.
 *
 * The run order is derived from `openPaths` at render (`groupRuns`), so
 * assigning a group never rewrites the stored order. Dragging moves a whole
 * run, or a tab within its own group — never a tab into a group, which would
 * make the drawn position and the stored membership disagree. */
export const RepoTabStrip = () => {
  const summary = useRepo((state) => state.summary);
  const missingPath = useRepo((state) => state.missingRepo?.path ?? null);
  const openPaths = useRepo((state) => state.openPaths);
  const recents = useRepo((state) => state.recents);
  const tabInfoByPath = useRepo((state) => state.tabInfoByPath);
  const loadRepo = useRepo((state) => state.loadRepo);
  const closeRepo = useRepo((state) => state.closeRepo);
  const setTabOrder = useRepo((state) => state.setTabOrder);
  const closeOnboarding = useUi((state) => state.closeOnboarding);
  const openMenu = useUi((state) => state.openMenu);
  // Names and groups are read off the two stored maps rather than one derived
  // selector: the strip re-renders when either changes, which is exactly when a
  // label or a run can move.
  const repoGroups = useUi((state) => state.repoGroups);
  const repoLabelsByIdentity = useUi((state) => state.repoLabelsByIdentity);
  const collapsedRepoGroups = useUi((state) => state.collapsedRepoGroups);
  const labels = { repoGroups, repoLabelsByIdentity };

  // The missing-repo state (GL-108) owns the tab strip like a live repo would,
  // so its tab highlights while the recovery screen is up.
  const activePath = summary?.path ?? missingPath;
  const identityOf = (path: string) => tabIdentity(path, tabInfoByPath[path]);
  const runs = groupRuns(
    openPaths,
    (path) => repoGroupOf(labels, identityOf(path))?.id ?? null,
    {
      collapsed: (groupId) => repoGroupCollapsed({ repoGroups, collapsedRepoGroups }, groupId),
      activePath,
    },
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (event.canceled) return;
      const { source } = event.operation;
      if (!isSortable(source)) return;
      // A run drag reorders the strip; a tab drag carries its group id, and
      // rearranges that group alone.
      const groupId = source.group;
      if (groupId === undefined) {
        setTabOrder(moveRun(runs, source.initialIndex, source.index));
        return;
      }
      const runIndex = runs.findIndex((run) => run.groupId === groupId);
      if (runIndex === -1) return;
      setTabOrder(moveWithinRun(runs, runIndex, source.initialIndex, source.index));
    },
    [runs, setTabOrder],
  );

  const tabPropsFor = (path: string): RunTabProps => {
    const active = path === activePath;
    return {
      active,
      // A background tab is flagged too when its path is already known dead —
      // via the recents probe or a previously entered missing state — so a dead
      // tab reads amber before it's ever clicked.
      missing: path === missingPath || !!recents.find((r) => r.path === path)?.missing,
      display: tabDisplay(path, tabInfoByPath[path], repoNameOf(labels, identityOf(path))),
      onSelect: () => {
        closeOnboarding();
        if (!active) void loadRepo(path);
      },
      onClose: () => void closeRepo(path),
      onContextMenu: (x: number, y: number) =>
        openMenu({ kind: MenuKind.RepoTab, state: { x, y, path } }),
    };
  };

  return (
    <DragDropProvider onDragEnd={handleDragEnd}>
      {runs.map((run, index) => (
        <RepoTabRun
          key={runKey(run)}
          run={run}
          index={index}
          group={run.groupId ? repoGroups.find((g) => g.id === run.groupId) : undefined}
          tabPropsFor={tabPropsFor}
        />
      ))}
    </DragDropProvider>
  );
};
