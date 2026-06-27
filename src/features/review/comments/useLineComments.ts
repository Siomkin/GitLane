// Per-file controller for the in-diff "local comment" system. Owns the
// drag-to-select range, the inline-editor draft, and the saved-card open state,
// and exposes a `rowFor(seq)` view-model the diff body renders per line. One
// instance per rendered file (single-file review, or each file in a stacked
// review), so two files' selections never interfere.
//
// Known limitation: drag-to-select extends via each row's `onMouseEnter`, so a
// selection only spans rows currently mounted by the virtualizer (the visible
// window + overscan). Dragging a range taller than the viewport stops at the
// edge; for a longer range, comment the lines individually.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useUi } from "../../../store/ui";
import { buildNote, refIndex, scopeText, type LineMeta } from "./notes";

type Range = { fromSeq: number; toSeq: number };
type EditRange = Range & { editId: string | null };
type Placed = { id: string; body: string; fromSeq: number; toSeq: number };

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
  fromSeq: Math.min(r.fromSeq, r.toSeq),
  toSeq: Math.max(r.fromSeq, r.toSeq),
});

export function useLineComments(file: string, lines: LineMeta[]): LineCommentsController {
  const allNotes = useUi((s) => s.reviewNotes);
  const addReviewNote = useUi((s) => s.addReviewNote);
  const removeReviewNote = useUi((s) => s.removeReviewNote);

  const [drag, setDrag] = useState<Range | null>(null);
  const [editRange, setEditRange] = useState<EditRange | null>(null);
  const [draft, setDraft] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const refToSeq = useMemo(() => refIndex(lines), [lines]);

  // Resolve each saved note's stored refs to positions in the *current* diff;
  // drop any whose anchor lines no longer exist (the diff re-flowed).
  const placed = useMemo<Placed[]>(() => {
    const out: Placed[] = [];
    for (const n of allNotes) {
      if (n.file !== file) continue;
      const a = refToSeq.get(n.fromRef);
      const b = refToSeq.get(n.toRef);
      if (a == null || b == null) continue;
      out.push({ id: n.id, body: n.body, fromSeq: Math.min(a, b), toSeq: Math.max(a, b) });
    }
    return out;
  }, [allNotes, file, refToSeq]);

  const anchorBySeq = useMemo(() => {
    const m = new Map<number, Placed>();
    for (const p of placed) m.set(p.toSeq, p);
    return m;
  }, [placed]);

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
    if (editRange && body) addReviewNote(buildNote(file, lines, editRange.fromSeq, editRange.toSeq, body));
    setEditRange(null);
    setDraft("");
  }, [addReviewNote, draft, editRange, file, lines]);

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
    (seq: number): LineRowComments => {
      const anchor = anchorBySeq.get(seq) ?? null;
      const sel = drag ?? editRange;
      const selecting = sel != null && seq >= Math.min(sel.fromSeq, sel.toSeq) && seq <= Math.max(sel.fromSeq, sel.toSeq);
      const covered = !selecting && placed.some((p) => seq >= p.fromSeq && seq <= p.toSeq);
      const editingThisAnchor = anchor != null && editRange?.editId === anchor.id;
      const editHere = editRange != null && seq === editRange.toSeq;
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
          setDrag({ fromSeq: seq, toSeq: seq });
          setEditRange(null);
          setOpenId(null);
        },
        onRowEnter: () => setDrag((d) => (d ? { fromSeq: d.fromSeq, toSeq: seq } : d)),
        toggleCard: () => {
          if (anchor) setOpenId((id) => (id === anchor.id ? null : anchor.id));
        },
        edit: () => {
          if (!anchor) return;
          setEditRange({ fromSeq: anchor.fromSeq, toSeq: anchor.toSeq, editId: anchor.id });
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
    [anchorBySeq, drag, editRange, openId, placed, lines, removeReviewNote],
  );

  return { active: drag != null || editRange != null, draft, setDraft, save, cancel, onDraftKey, rowFor };
}
