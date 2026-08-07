import type { DragEvent as ReactDragEvent } from "react";
import { BranchKind } from "@/lib/api";
import type { BranchRefKind } from "@/lib/graphActions";
import { useUi, MenuKind } from "@/store/ui";

export type BranchRefDragOptions =
  | {
      draggable: false;
      stopPropagation?: boolean;
    }
  | {
      draggable: true;
      kind: BranchRefKind;
      /** Only local branches are writable graph targets. */
      droppable: boolean;
      stopPropagation?: boolean;
    };

/** Drag-and-drop wiring shared by every draggable branch-ref affordance — the
 * graph's `RefPill` and the branch navigator's rows. The ref is both a drag
 * source (start a branch op) and a drop target (drop another ref onto it →
 * action menu). Reads/writes the `ui` store exactly as the call sites did.
 *
 * Returns the `isDropTarget` flag (for the drop highlight) plus `dndProps` to
 * spread onto the row element. */
export function useBranchRefDrag(
  refName: string,
  options: BranchRefDragOptions,
) {
  const stopPropagation = options.stopPropagation ?? false;
  const draggingFrom = useUi((s) => s.draggingFrom);
  const startDrag = useUi((s) => s.startDrag);
  const clearDrag = useUi((s) => s.clearDrag);
  const openMenu = useUi((s) => s.openMenu);

  const droppable = options.draggable ? options.droppable : false;
  const isSameRef =
    options.draggable &&
    draggingFrom?.name === refName &&
    draggingFrom.kind === options.kind;
  // Remote-tracking refs are read-only targets: only a dragged local branch can
  // move onto one. Use the same predicate for highlight, drag-over, and drop so
  // the UI never advertises an inert target.
  const canDropHere =
    droppable &&
    draggingFrom != null &&
    !isSameRef &&
    (options.draggable && (options.kind === BranchKind.Local || draggingFrom.kind === BranchKind.Local));
  const isDropTarget = canDropHere;

  if (!options.draggable) return { isDropTarget, dndProps: { draggable: false as const } };

  const dndProps = {
    draggable: true as const,
    onDragStart: (e: ReactDragEvent<HTMLElement>) => {
      if (stopPropagation) e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", refName);
      } catch {
        /* ignore */
      }
      startDrag({ name: refName, kind: options.kind });
    },
    onDragOver: (e: ReactDragEvent<HTMLElement>) => {
      if (canDropHere) e.preventDefault();
    },
    onDrop: (e: ReactDragEvent<HTMLElement>) => {
      if (stopPropagation) e.stopPropagation();
      if (!canDropHere) {
        clearDrag();
        return;
      }
      e.preventDefault();
      openMenu({ kind: MenuKind.Action, state: {
        x: e.clientX,
        y: e.clientY,
        from: draggingFrom,
        // The drop target's kind is this element's own kind: dropping onto a
        // remote-tracking ref yields a `remote` target, onto a local branch a
        // `local` target. The dragged branch is the one that moves onto the
        // target (a remote source is the exception — it can't move, so it feeds
        // the local target instead).
        to: { kind: options.kind, name: refName },
      } });
    },
    onDragEnd: () => clearDrag(),
  };

  return { isDropTarget, dndProps };
}
