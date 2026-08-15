// Local review comments pinned to diff line ranges, and the "hand to agent"
// composer built out of them.

import type { SliceSet } from "./slice";

/** A freeform review ("local") comment pinned to a contiguous range of diff
 * lines. Session-only — never persisted; collected and bundled into the "hand to
 * agent" message. A single-line comment is just a range whose ends coincide. */
export interface ReviewNote {
  /** Deterministic key: `${surface}#${file}#${fromRef}-${toRef}` (one note per range). */
  id: string;
  /** The diff surface this note belongs to (e.g. "work", "commit:<oid>",
   * "range:<base>..<head>", "pr:<num>"), so the same file/line in a different
   * diff doesn't re-attach the note or fold it into the wrong hand-off. */
  surface: string;
  /** Path of the file the range belongs to. */
  file: string;
  /** Anchor (range-end) side, kept for stable ordering. "L" = old, "R" = new/ctx. */
  side: "L" | "R";
  /** Anchor (range-end) line number on that side, kept for ordering. */
  line: number;
  /** Display ref of the range start, e.g. "R18" / "L4". */
  fromRef: string;
  /** Display ref of the range end (the anchor), e.g. "R20". */
  toRef: string;
  /** Combined display label, e.g. "R20" or "R18–R20". */
  lineRef: string;
  /** The range's source text (joined), captured for context in the message. */
  code: string;
  /** The reviewer's note. */
  body: string;
}

export interface ReviewNotesSlice {
  /** Session-only review notes pinned to diff lines — the input to the "prepare
   * message for agent" flow. Never persisted (cleared on repo switch). */
  reviewNotes: ReviewNote[];
  /** The "prepare message for agent" popup, plus the diff surface(s) + branch it
   * was opened from — so it composes from those surfaces' notes against the right
   * branch. (A set, because the working review mixes staged + unstaged sources.) */
  agentMessageOpen: boolean;
  agentMessageSurfaces: string[];
  agentMessageBranch: string | null;

  /** Pin/replace a local comment on a diff line range (keyed by file + range). */
  addReviewNote: (note: Omit<ReviewNote, "id">) => void;
  removeReviewNote: (id: string) => void;
  clearReviewNotes: () => void;
  openAgentMessage: (surfaces: string[], branch: string | null) => void;
  closeAgentMessage: () => void;
}

/** Local review comments and the hand-to-agent composer built from them. Both
 * are pinned to the previous repo's diffs. */
export const resetReviewNotes = () =>
  ({
    reviewNotes: [],
    agentMessageOpen: false,
    agentMessageSurfaces: [],
    agentMessageBranch: null,
  }) satisfies Partial<ReviewNotesSlice>;

/** The hand-to-agent composer owns the keyboard while it is up. */
export const overlayOpenReviewNotes = (s: ReviewNotesSlice) => s.agentMessageOpen;

export function createReviewNotesSlice(set: SliceSet<ReviewNotesSlice>): ReviewNotesSlice {
  return {
    ...resetReviewNotes(),

    addReviewNote: (note) =>
      set((s) => {
        // One note per range per surface: replace any existing note with the same key.
        const id = `${note.surface}#${note.file}#${note.fromRef}-${note.toRef}`;
        const rest = s.reviewNotes.filter((n) => n.id !== id);
        return { reviewNotes: [...rest, { ...note, id }] };
      }),
    removeReviewNote: (id) => set((s) => ({ reviewNotes: s.reviewNotes.filter((n) => n.id !== id) })),
    clearReviewNotes: () =>
      set((s) => (s.reviewNotes.length ? { reviewNotes: [], agentMessageOpen: false } : s)),
    openAgentMessage: (surfaces, branch) =>
      set({ agentMessageOpen: true, agentMessageSurfaces: surfaces, agentMessageBranch: branch }),
    closeAgentMessage: () => set({ agentMessageOpen: false }),
  };
}
