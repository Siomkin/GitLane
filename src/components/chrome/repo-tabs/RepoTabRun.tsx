import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { useSortable } from "@dnd-kit/react/sortable";
import { cn } from "@/lib/cn";
import { runKey, type TabDisplay, type TabRun } from "@/lib/tabs";
import type { RepoGroup } from "@/store/ui";
import { CollapsedGroupChip, GroupChip } from "./GroupChip";
import { ProjectTab } from "./ProjectTab";

/** Drag types. A group's tabs accept only their own group's tabs, so a tab has
 * no valid drop target outside its run — dragging cannot change membership
 * (that is the context menu's job), which is what stops a tab from *looking*
 * grouped without being grouped. */
const RUN_DRAG_TYPE = "repo-run";
const tabDragType = (groupId: string) => `repo-tab:${groupId}`;

/**
 * Distance-only activation for a group run, replacing dnd-kit's mouse default
 * of `Delay(200ms, tolerance 10)` **or** `Distance(5px)`.
 *
 * The delay half is what made group dragging jitter: with it, any press that
 * lingers past 200ms without moving activates a drag on its own, so a slow
 * click — or either half of a double-click — pops the drag feedback and drops
 * it again. Tabs never showed this because their drag handle (the dot grid)
 * makes dnd-kit skip activation constraints entirely; a group run has no handle
 * (one covering the well would swallow the clicks inside it), so it gets the
 * defaults, and the delay with them.
 *
 * 5px of movement, and nothing else, starts a group drag. Clicks, double-clicks
 * and right-clicks inside the well all survive.
 */
const RUN_SENSORS = [
  PointerSensor.configure({
    activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
];

/** What every tab in a run needs from the strip, per path. */
export interface RunTabProps {
  active: boolean;
  missing: boolean;
  display: TabDisplay;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
}

/** One tab inside a group: its own sortable, scoped to that group. */
const GroupedTab = ({
  path,
  index,
  groupId,
  tab,
}: {
  path: string;
  index: number;
  groupId: string;
  tab: RunTabProps;
}) => {
  const sortable = useSortable({
    id: path,
    index,
    group: groupId,
    type: tabDragType(groupId),
    accept: tabDragType(groupId),
  });
  return (
    <ProjectTab
      path={path}
      {...tab}
      drag={{ ref: sortable.ref, handleRef: sortable.handleRef, dragging: sortable.isDragging }}
    />
  );
};

/**
 * One run of the tab strip: a group drawn as a bordered cluster behind its
 * chip, or a lone ungrouped tab.
 *
 * The run itself is the sortable at strip level — a group moves with all of
 * its tabs, and a lone ungrouped tab drags as its own run. Tabs inside a group
 * are a second, group-scoped sortable list, so reordering happens *within* the
 * group only.
 */
export const RepoTabRun = ({
  run,
  index,
  group,
  tabPropsFor,
}: {
  run: TabRun;
  index: number;
  /** The run's group, when it has one (a missing group means ungrouped). */
  group: RepoGroup | undefined;
  tabPropsFor: (path: string) => RunTabProps;
}) => {
  const sortable = useSortable({
    id: runKey(run),
    index,
    type: RUN_DRAG_TYPE,
    accept: RUN_DRAG_TYPE,
    sensors: RUN_SENSORS,
  });

  // Ungrouped: the tab *is* the run, so it drags by the run's own handle.
  if (!group) {
    const path = run.paths[0];
    return (
      <ProjectTab
        path={path}
        {...tabPropsFor(path)}
        drag={{ ref: sortable.ref, handleRef: sortable.handleRef, dragging: sortable.isDragging }}
      />
    );
  }

  // Collapsed: the well folds to a single pill, which becomes the drag handle.
  // The active tab, if this group holds it, is still drawn beside the pill —
  // the strip must never stop showing where the user is.
  if (run.collapsed) {
    return (
      <div
        ref={sortable.ref}
        data-group={group.id}
        data-collapsed="true"
        data-dragging={sortable.isDragging ? "true" : undefined}
        className="flex shrink-0 items-center gap-1 transition-opacity data-[dragging=true]:opacity-60"
      >
        <CollapsedGroupChip group={group} count={run.paths.length} />
        {/* The tab keeps its real position in `paths`, not a hardcoded 0: a
            one-item sortable list can only ever report index 0 today, but a
            lying index would make `moveWithinRun` splice the wrong path the
            moment that stops being true. The run itself must stay handle-less
            — dnd-kit binds pointerdown to the handle alone when one is
            declared, which would leave the pill undraggable. */}
        {run.drawn.map((path) => (
          <GroupedTab
            key={path}
            path={path}
            index={run.paths.indexOf(path)}
            groupId={group.id}
            tab={tabPropsFor(path)}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      // No `handleRef`: dnd-kit drops its activation constraints entirely for a
      // press that lands inside a declared handle, so a handle covering the
      // whole well starts a drag on pointerdown and the click never arrives —
      // which killed both the collapse gesture and the group menu. The well is
      // the plain sortable element instead, dragged after 5px (`RUN_SENSORS`).
      ref={sortable.ref}
      data-group={group.id}
      data-dragging={sortable.isDragging ? "true" : undefined}
      // A recessed tinted well, no ring: the group reads as a tray the tabs
      // sit in, so an ungrouped tab beside it can't be mistaken for a member
      // (design 1C).
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-[10px] p-[3px] transition-opacity data-[dragging=true]:opacity-60",
        "bg-black/[0.035] dark:bg-white/[0.045]",
      )}
    >
      <GroupChip group={group} />
      {run.drawn.map((path, tabIndex) => (
        <GroupedTab
          key={path}
          path={path}
          index={tabIndex}
          groupId={group.id}
          tab={tabPropsFor(path)}
        />
      ))}
    </div>
  );
};
