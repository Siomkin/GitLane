// The shapes a conflicted file is modelled as: the regions it parses into,
// the decision each conflict region carries, and the rows the panes render.

export interface Token {
  v: string;
  cls: string;
}

/** A run of unconflicted context lines. */
export interface ContextRegion {
  kind: "ctx";
  lines: string[];
}

/** One conflict hunk: the two (optionally three, with diff3 base) sides. */
export interface ConflictRegion {
  kind: "cf";
  ours: string[];
  theirs: string[];
  /** diff3 common-ancestor lines, when the file uses `merge.conflictStyle=diff3`. */
  base: string[] | null;
  /** True when the hunk's markers were structurally incomplete — a missing
   * `=======` split or `>>>>>>>` close (truncated or nested markers). Such a hunk
   * cannot be safely reconstructed in-app, so it blocks staging until the user
   * fixes the file in their own editor. */
  malformed: boolean;
}

export type Region = ContextRegion | ConflictRegion;

/** How one conflict hunk was resolved. `undefined` = still undecided. */
/** How one hunk was resolved. "custom" is text that exists in neither side —
 * an agent rewrite the tick model cannot express — kept per hunk alongside the
 * decision so the Output pane can hold it like any other resolution. */
export type RegionDecision = "ours" | "theirs" | "both" | "lines" | "custom";

/** Per-hunk line picks for the "Side by side" line editor: a set of `a:<i>`
 * (ours line i) / `b:<i>` (theirs line i) keys. */
export type LineSelection = Set<string>;

/** One reconstructed line plus which side it came from ("a" = ours, "b" =
 * theirs), so the decided view can tint it. */
export interface ResolvedRow {
  line: string;
  /** "ai" for custom (rewritten) lines, which came from neither side. */
  side: "a" | "b" | "ai";
}

/** One row in the A (ours) or B (theirs) pane of the line editor. */
export interface PaneRow {
  no: number;
  tokens: Token[];
  /** True for a selectable conflict line; false for surrounding context. */
  conflict: boolean;
  picked: boolean;
  side: "a" | "b";
  regionIdx: number;
  lineIdx: number;
  /** First line of this hunk's side — anchors the whole-block toggle. */
  blockFirst: boolean;
  blockAll: boolean;
  blockSome: boolean;
}

/** One row in the Output (merged result) pane. */
export type OutputRow =
  | {
      kind: "placeholder";
      conflictNo: number;
      regionIdx: number;
      /** A custom resolution that deliberately keeps nothing — decided, not
       * waiting for picks. */
      dropped?: boolean;
    }
  | {
      kind: "line";
      no: number;
      /** Source text for this row — do not reconstruct from `tokens`.
       * `tokenize("")` inserts a spacer glyph for layout; round-tripping that
       * into the Output editor turns a blank line into a space and jumps the
       * caret to EOF on the next keystroke. */
      text: string;
      tokens: Token[];
      side: "a" | "b" | "ai";
      regionIdx: number;
      lineIdx: number;
      /** Picked conflict lines can be removed; context lines cannot. */
      removable: boolean;
    };

export interface LineEditor {
  aRows: PaneRow[];
  bRows: PaneRow[];
  outRows: OutputRow[];
  /** Aggregate selection state for the pane "Accept all" headers. */
  aAll: boolean;
  aSome: boolean;
  bAll: boolean;
  bSome: boolean;
}
