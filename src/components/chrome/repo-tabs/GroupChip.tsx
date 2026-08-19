import type { KeyboardEvent, MouseEvent } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { ChevronRightIcon } from "@/components/ui/icons";
import { MenuKind, useUi, type RepoGroup } from "@/store/ui";

/** What both presentations of a group share: double-click folds or unfolds it,
 * right-click raises the group menu.
 *
 * One gesture in both directions — a single click to expand and a double to
 * collapse read as two different controls — and double rather than single
 * because a single press here is how the group is dragged. Enter and Space
 * toggle too, for whichever surface is focusable. */
function useGroupGestures(group: RepoGroup) {
  const toggleRepoGroupCollapsed = useUi((state) => state.toggleRepoGroupCollapsed);
  const openMenu = useUi((state) => state.openMenu);
  const toggle = () => toggleRepoGroupCollapsed(group.id);
  return {
    onDoubleClick: toggle,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    },
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu({
        kind: MenuKind.RepoGroup,
        state: { x: e.clientX, y: e.clientY, groupId: group.id },
      });
    },
  };
}

/** The head of an expanded group's well: the group's name, then the hairline
 * that separates it from the tabs (design 1C, "tinted well + divider").
 *
 * Renaming is the group menu's `Rename group…` — an in-place editor here
 * competed with both gestures above, and a name you can't click is worth more
 * than a second way to rename.
 *
 * Deliberately desaturated rather than drawn in the group's colour: a group
 * must never outrank the active tab, which is the one white thing in the
 * strip. The colour survives where it costs nothing — the swatch in the group
 * menus and the recents sections. */
export const GroupChip = ({ group }: { group: RepoGroup }) => {
  const gestures = useGroupGestures(group);
  return (
    <>
      <span
        {...gestures}
        title={`${group.name} — double-click to collapse, right-click for group actions`}
        className={cn(
          "flex h-[26px] max-w-28 shrink-0 cursor-pointer select-none items-center truncate px-2",
          "text-[11px] font-bold uppercase tracking-[0.05em] text-slate-400 dark:text-slate-500",
          "hover:text-slate-500 dark:hover:text-slate-400",
        )}
      >
        {group.name}
      </span>
      <span aria-hidden="true" className="mx-[3px] h-4 w-px shrink-0 bg-black/10 dark:bg-white/10" />
    </>
  );
};

/** A collapsed group, drawn as the design's single pill: chevron, name, and
 * how many tabs the group holds — the full membership, including any tab still
 * drawn beside it, because that is the number worth knowing before expanding.
 *
 * The whole pill is one control; nothing inside it is separately clickable,
 * which is what keeps it reading as one unit rather than a row of little
 * buttons. Right-click is the only menu a collapsed group has — its members'
 * tabs are folded away, so there is nothing else left to right-click.
 *
 * A `div role="button"`, deliberately not a `<button>`: dnd-kit's pointer
 * sensor refuses to start a drag from a press that lands on a nested
 * interactive element, and `getInteractiveElement` matches by tag
 * (`button`, `a[href]`, inputs) — not by role. As a real `<button>` the pill
 * was unclickable-to-drag, so a collapsed group could not be moved at all. */
export const CollapsedGroupChip = ({ group, count }: { group: RepoGroup; count: number }) => {
  const gestures = useGroupGestures(group);
  return (
    <div
      role="button"
      tabIndex={0}
      {...gestures}
      aria-expanded={false}
      aria-label={`Expand group ${group.name}, ${count} ${count === 1 ? "tab" : "tabs"}`}
      title={`${group.name} — double-click to expand, right-click for group actions`}
      className={cn(
        "flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-lg bg-black/[0.05] px-[9px] text-[12px] font-semibold",
        "text-neutral-600 hover:bg-black/[0.08] dark:bg-white/[0.07] dark:text-neutral-300 dark:hover:bg-white/[0.11]",
        focusRing,
      )}
    >
      <ChevronRightIcon className="h-3 w-3 shrink-0 text-neutral-400" />
      <span className="max-w-28 truncate">{group.name}</span>
      <span
        // Decorative: the count is already in this button's own label, and a
        // bare number announced on its own tells a screen reader nothing.
        aria-hidden="true"
        className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-black/[0.08] px-1 text-[10px] font-semibold text-neutral-500 dark:bg-white/[0.12] dark:text-neutral-400"
      >
        {count}
      </span>
    </div>
  );
};
