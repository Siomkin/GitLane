// Per-file controller for the in-diff "local comment" system. Owns the
// drag-to-select range, the inline-editor draft, and the saved-card open state,
// and exposes a `rowFor(seq)` view-model the diff body renders per line. One
// Single-file views use one controller; the stacked review shares one state
// machine across its loaded file map and asks it for a file-scoped controller,
// so selections never cross file boundaries.
//
// Known limitation: drag-to-select extends via each row's `onMouseEnter`, so a
// selection only spans rows currently mounted by the virtualizer (the visible
// window + overscan). Dragging a range taller than the viewport stops at the
// edge; for a longer range, comment the lines individually.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useUi } from "@/store/ui";
import { buildNote, refIndex, scopeText, type LineMeta } from "./notes";

type Range = { file: string; fromSeq: number; toSeq: number };
type EditRange = Range & { editId: string | null };
type Placed = { id: string; body: string; fromSeq: number; toSeq: number };
type FileContext = {
  lines: LineMeta[];
  placed: Placed[];
  anchorBySeq: Map<number, Placed>;
};

/** Per-line view-model for the comment affordances (handle column + cards). */
export interface LineRowComments {
  /** Inside a saved note's range — paints a neutral left rail. */
  covered: boolean;
  /** Inside the active drag/edit range — paints the accent rail/background. */
  selecting: boolean;
  /** No note ends here and we're not editing here — show the grab handle. */
  showHandle: boolean;
  /** A saved note ends on this line — show the toggle marker. */
  isAnchor: boolean;
  /** That anchor's saved card is expanded. */
  cardOpen: boolean;
  /** The inline editor renders under this line (the range end). */
  editHere: boolean;
  /** The saved card renders under this line. */
  showCard: boolean;
  /** Header text for the editor/card ("Comment on line(s) …"). */
  scope: string;
  /** Saved note body (when this line is an open anchor). */
  body: string;
  onHandleDown: (e: ReactMouseEvent) => void;
  onRowEnter: () => void;
  toggleCard: () => void;
  edit: () => void;
  remove: () => void;
}

export interface LineCommentsController {
  /** A drag or edit is in progress (callers can suppress other hover affordances). */
  active: boolean;
  draft: string;
  setDraft: (v: string) => void;
  save: () => void;
  cancel: () => void;
  onDraftKey: (e: ReactKeyboardEvent) => void;
  rowFor: (seq: number) => LineRowComments;
}

const norm = (r: Range): Range => ({
  file: r.file,
  fromSeq: Math.min(r.fromSeq, r.toSeq),
  toSeq: Math.max(r.fromSeq, r.toSeq),
});

/** One comment state machine shared by every currently loaded file in a stacked
 * review. Only one range/editor can be active at a time, so this preserves the
 * single-file interaction model without mounting one hook/controller per file. */
export function useMultiFileLineComments(
  surface: string,
  linesByFile: ReadonlyMap<string, LineMeta[]>,
  opts?: {
    confineDragToSide?: boolean;
    /** Resolve an internal controller key to the real persisted note path.
     * Multi-occurrence views use this to isolate duplicate path sections while
     * keeping ReviewNote.file stable and human-readable. */
    noteFileForKey?: (key: string) => string;
  },
): { controllerFor: (file: string) => LineCommentsController } {
  // Split view confines a drag to the side it started on (left/old vs right/new),
  // so dragging across columns doesn't select the interleaved opposite side.
  const confineDragToSide = !!opts?.confineDragToSide;
  const noteFileForKey = opts?.noteFileForKey;
  const allNotes = useUi((s) => s.reviewNotes);
  const addReviewNote = useUi((s) => s.addReviewNote);
  const removeReviewNote = useUi((s) => s.removeReviewNote);

  const [drag, setDrag] = useState<Range | null>(null);
  const [editRange, setEditRange] = useState<EditRange | null>(null);
  const [draft, setDraft] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  // Resolve saved refs independently for each loaded file. Files outside the
  // virtualized review's loaded set have no controller state or line metadata.
  const contexts = useMemo(() => {
    const result = new Map<string, FileContext>();
    for (const [file, lines] of linesByFile) {
      const noteFile = noteFileForKey?.(file) ?? file;
      const refToSeq = refIndex(lines);
      const placed: Placed[] = [];
      for (const note of allNotes) {
        if (note.surface !== surface || note.file !== noteFile) continue;
        const a = refToSeq.get(note.fromRef);
        const b = refToSeq.get(note.toRef);
        if (a == null || b == null) continue;
        placed.push({
          id: note.id,
          body: note.body,
          fromSeq: Math.min(a, b),
          toSeq: Math.max(a, b),
        });
      }
      const anchorBySeq = new Map<number, Placed>();
      for (const note of placed) anchorBySeq.set(note.toSeq, note);
      result.set(file, { lines, placed, anchorBySeq });
    }
    return result;
  }, [allNotes, surface, linesByFile, noteFileForKey]);

  // Release anywhere ends a drag and opens the editor over the selected range —
  // a click (no movement) yields a single-line range.
  useEffect(() => {
    if (!drag) return;
    const onUp = () => {
      const r = norm(drag);
      setEditRange({ ...r, editId: null });
      setDraft("");
      setOpenId(null);
      setDrag(null);
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [drag]);

  const save = useCallback(() => {
    const body = draft.trim();
    const lines = editRange ? contexts.get(editRange.file)?.lines : undefined;
    if (editRange && lines && body) {
      addReviewNote(
        buildNote(
          surface,
          noteFileForKey?.(editRange.file) ?? editRange.file,
          lines,
          editRange.fromSeq,
          editRange.toSeq,
          body,
        ),
      );
    }
    setEditRange(null);
    setDraft("");
  }, [addReviewNote, contexts, draft, editRange, noteFileForKey, surface]);

  const cancel = useCallback(() => {
    setEditRange(null);
    setDraft("");
  }, []);

  const onDraftKey = useCallback(
    (e: ReactKeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [save, cancel],
  );

  const rowFor = useCallback(
    (file: string, seq: number): LineRowComments => {
      const context = contexts.get(file);
      const lines = context?.lines ?? [];
      const anchor = context?.anchorBySeq.get(seq) ?? null;
      const selecting =
        (drag?.file === file && seq >= Math.min(drag.fromSeq, drag.toSeq) && seq <= Math.max(drag.fromSeq, drag.toSeq)) ||
        (editRange?.file === file &&
          seq >= Math.min(editRange.fromSeq, editRange.toSeq) &&
          seq <= Math.max(editRange.fromSeq, editRange.toSeq));
      const covered =
        !selecting && !!context?.placed.some((note) => seq >= note.fromSeq && seq <= note.toSeq);
      const editingThisAnchor =
        anchor != null && editRange?.file === file && editRange.editId === anchor.id;
      const editHere = editRange?.file === file && seq === editRange.toSeq;
      const cardOpen = anchor != null && openId === anchor.id && !editingThisAnchor;
      const scope = editHere
        ? scopeText(lines[editRange.fromSeq]?.ref ?? "", lines[editRange.toSeq]?.ref ?? "")
        : anchor
          ? scopeText(lines[anchor.fromSeq]?.ref ?? "", lines[anchor.toSeq]?.ref ?? "")
          : "";
      return {
        covered,
        selecting,
        showHandle: anchor == null && !editHere,
        isAnchor: anchor != null,
        cardOpen,
        editHere,
        showCard: cardOpen,
        scope,
        body: anchor?.body ?? "",
        onHandleDown: (e) => {
          e.preventDefault();
          e.stopPropagation();
          setDrag({ file, fromSeq: seq, toSeq: seq });
          setEditRange(null);
          setOpenId(null);
        },
        onRowEnter: () =>
          setDrag((d) => {
            if (!d || d.file !== file) return d;
            // In split view, only extend across rows on the same side.
            if (confineDragToSide && lines[seq]?.side !== lines[d.fromSeq]?.side) return d;
            return { file, fromSeq: d.fromSeq, toSeq: seq };
          }),
        toggleCard: () => {
          if (anchor) setOpenId((id) => (id === anchor.id ? null : anchor.id));
        },
        edit: () => {
          if (!anchor) return;
          setEditRange({
            file,
            fromSeq: anchor.fromSeq,
            toSeq: anchor.toSeq,
            editId: anchor.id,
          });
          setDraft(anchor.body);
          setOpenId(null);
        },
        remove: () => {
          if (!anchor) return;
          removeReviewNote(anchor.id);
          setOpenId((id) => (id === anchor.id ? null : id));
        },
      };
    },
    [confineDragToSide, contexts, drag, editRange, openId, removeReviewNote],
  );

  const controllerFor = useCallback(
    (file: string): LineCommentsController => ({
      active: drag?.file === file || editRange?.file === file,
      draft,
      setDraft,
      save,
      cancel,
      onDraftKey,
      rowFor: (seq) => rowFor(file, seq),
    }),
    [cancel, drag, draft, editRange, onDraftKey, rowFor, save],
  );

  return { controllerFor };
}

export function useLineComments(
  surface: string,
  file: string,
  lines: LineMeta[],
  opts?: { confineDragToSide?: boolean },
): LineCommentsController {
  const linesByFile = useMemo(() => new Map([[file, lines]]), [file, lines]);
  return useMultiFileLineComments(surface, linesByFile, opts).controllerFor(file);
}
