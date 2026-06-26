// Pure conflict-marker model for the in-app editor — no React, no IPC, so it's
// trivially testable. The backend (`git::conflicts::conflict_file`) hands us the
// worktree copy of a conflicted file *with* git's `<<<<<<< / ======= / >>>>>>>`
// markers; this module parses it into hunks, reconstructs the merged text from
// the user's per-hunk choices, and provides lightweight syntax tokenization for
// the diff rows. The component layer is a dumb painter over these outputs.

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
export type RegionDecision = "ours" | "theirs" | "both" | "lines";

/** Per-hunk line picks for the "Side by side" line editor: a set of `a:<i>`
 * (ours line i) / `b:<i>` (theirs line i) keys. */
export type LineSelection = Set<string>;

const MARK_OURS = "<<<<<<<";
const MARK_BASE = "|||||||";
const MARK_SPLIT = "=======";
const MARK_THEIRS = ">>>>>>>";

/**
 * Parse conflicted file content into context + conflict regions. Handles both
 * the default 2-way markers and diff3 (with a `|||||||` base section). Lines are
 * split on `\n`; a trailing newline does not produce a phantom empty line.
 */
export function parseConflict(content: string): Region[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const regions: Region[] = [];
  let ctx: string[] = [];
  const flushCtx = () => {
    if (ctx.length > 0) {
      regions.push({ kind: "ctx", lines: ctx });
      ctx = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith(MARK_OURS)) {
      flushCtx();
      const ours: string[] = [];
      const theirs: string[] = [];
      let base: string[] | null = null;
      i++; // skip the <<<<<<< marker
      while (i < lines.length && !lines[i].startsWith(MARK_BASE) && !lines[i].startsWith(MARK_SPLIT)) {
        ours.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith(MARK_BASE)) {
        base = [];
        i++; // skip |||||||
        while (i < lines.length && !lines[i].startsWith(MARK_SPLIT)) {
          base.push(lines[i]);
          i++;
        }
      }
      // A well-formed hunk has both a `=======` split and a `>>>>>>>` close. If
      // either is missing the markers are corrupt (truncated/nested) and the
      // reconstructed text would be wrong — flag the hunk so callers refuse to
      // stage it (see `hasMalformedHunk` / `isResolved`).
      let sawSplit = false;
      let sawTheirs = false;
      if (i < lines.length && lines[i].startsWith(MARK_SPLIT)) {
        sawSplit = true;
        i++; // skip =======
      }
      while (i < lines.length && !lines[i].startsWith(MARK_THEIRS)) {
        theirs.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith(MARK_THEIRS)) {
        sawTheirs = true;
        i++; // skip >>>>>>>
      }
      regions.push({ kind: "cf", ours, theirs, base, malformed: !sawSplit || !sawTheirs });
    } else {
      ctx.push(lines[i]);
      i++;
    }
  }
  flushCtx();
  return regions;
}

/** Number of conflict hunks in a parsed file. */
export function conflictRegionCount(regions: Region[]): number {
  return regions.filter((r) => r.kind === "cf").length;
}

/** True when any hunk had structurally incomplete markers. A file with a
 * malformed hunk can't be reconstructed safely, so the UI must keep it out of
 * the stageable set and steer the user to fix it externally. */
export function hasMalformedHunk(regions: Region[]): boolean {
  return regions.some((r) => r.kind === "cf" && r.malformed);
}

/** Whether `content` ended with a newline, so {@link buildResolved} can preserve
 * a file that had no trailing newline instead of silently appending one. */
export function endsWithNewline(content: string): boolean {
  return content.endsWith("\n");
}

/**
 * The effective decision for a hunk, reconciling the two inputs: a non-empty
 * line selection (from the line editor) always means "lines"; otherwise the
 * whole-hunk decision (from inline mode) stands. This is what lets a hunk be
 * resolved either way and keeps the two editors consistent.
 */
export function effectiveDecision(
  decision: RegionDecision | undefined,
  selection: LineSelection | undefined,
): RegionDecision | undefined {
  if (selection && selection.size > 0) return "lines";
  return decision;
}

/** Seed a line selection from a whole-hunk decision, so switching a hunk that
 * was accepted ours/theirs/both into the line editor starts pre-ticked. */
export function deriveSelection(
  region: ConflictRegion,
  decision: RegionDecision | undefined,
): LineSelection {
  const sel = new Set<string>();
  if (decision === "ours" || decision === "both") region.ours.forEach((_, i) => sel.add(`a:${i}`));
  if (decision === "theirs" || decision === "both") region.theirs.forEach((_, i) => sel.add(`b:${i}`));
  return sel;
}

/** How many conflict hunks have an effective decision recorded. */
export function decidedCount(
  regions: Region[],
  decisions: Record<number, RegionDecision | undefined>,
  lineSel: Record<number, LineSelection> = {},
): number {
  let n = 0;
  regions.forEach((r, idx) => {
    if (r.kind === "cf" && effectiveDecision(decisions[idx], lineSel[idx])) n += 1;
  });
  return n;
}

/** True when every conflict hunk has been decided (file ready to stage). */
export function isResolved(
  regions: Region[],
  decisions: Record<number, RegionDecision | undefined>,
  lineSel: Record<number, LineSelection> = {},
): boolean {
  return (
    conflictRegionCount(regions) > 0 &&
    !hasMalformedHunk(regions) &&
    decidedCount(regions, decisions, lineSel) === conflictRegionCount(regions)
  );
}

/**
 * Reconstruct the merged file text from the user's per-hunk choices. Context
 * regions pass through unchanged; conflict hunks emit the chosen side(s).
 * Undecided hunks are dropped, so callers should only build text once
 * {@link isResolved} is true.
 *
 * `trailingNewline` should reflect whether the *original* conflicted file ended
 * with a newline (see {@link endsWithNewline}); pass `false` to avoid adding one
 * to a file that didn't have it, which would otherwise be a spurious content
 * change beyond the resolution. Defaults to `true` (the common case).
 */
export function buildResolved(
  regions: Region[],
  decisions: Record<number, RegionDecision | undefined>,
  lineSel: Record<number, LineSelection>,
  trailingNewline = true,
): string {
  const out: string[] = [];
  regions.forEach((region, idx) => {
    if (region.kind === "ctx") {
      out.push(...region.lines);
      return;
    }
    const dec = effectiveDecision(decisions[idx], lineSel[idx]);
    if (dec === "ours") out.push(...region.ours);
    else if (dec === "theirs") out.push(...region.theirs);
    else if (dec === "both") out.push(...region.ours, ...region.theirs);
    else if (dec === "lines") {
      const sel = lineSel[idx] ?? new Set<string>();
      region.ours.forEach((line, i) => {
        if (sel.has(`a:${i}`)) out.push(line);
      });
      region.theirs.forEach((line, i) => {
        if (sel.has(`b:${i}`)) out.push(line);
      });
    }
  });
  // A resolution that contributes no lines (e.g. accepting an empty side for a
  // whole-file conflict) is a genuinely empty file — return "" rather than the
  // lone "\n" that `join("\n") + "\n"` would produce, which would corrupt an
  // intended empty resolution.
  if (out.length === 0) return "";
  const text = out.join("\n");
  return trailingNewline ? text + "\n" : text;
}

/** One reconstructed line plus which side it came from ("a" = ours, "b" =
 * theirs), so the decided view can tint it. */
export interface ResolvedRow {
  line: string;
  side: "a" | "b";
}

/** The lines a decided hunk contributes, with their side, for rendering the
 * resolved result (mirrors {@link buildResolved} but keeps side provenance). */
export function resolvedRows(
  region: ConflictRegion,
  decision: RegionDecision | undefined,
  selection: LineSelection,
): ResolvedRow[] {
  if (decision === "ours") return region.ours.map((line) => ({ line, side: "a" }));
  if (decision === "theirs") return region.theirs.map((line) => ({ line, side: "b" }));
  if (decision === "both")
    return [
      ...region.ours.map((line) => ({ line, side: "a" as const })),
      ...region.theirs.map((line) => ({ line, side: "b" as const })),
    ];
  if (decision === "lines") {
    const rows: ResolvedRow[] = [];
    region.ours.forEach((line, i) => {
      if (selection.has(`a:${i}`)) rows.push({ line, side: "a" });
    });
    region.theirs.forEach((line, i) => {
      if (selection.has(`b:${i}`)) rows.push({ line, side: "b" });
    });
    return rows;
  }
  return [];
}

// ---- Side-by-side line editor view-model ----

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
  | { kind: "placeholder"; conflictNo: number; regionIdx: number }
  | {
      kind: "line";
      no: number;
      tokens: Token[];
      side: "a" | "b";
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

/**
 * Build the three-pane line editor view-model (ours pane, theirs pane, merged
 * output) from the parsed regions and a per-hunk effective line selection. The
 * Output pane shows context lines, then for each hunk either the picked lines
 * (in ours-then-theirs order) or a "pick lines" placeholder. Pure — the
 * component paints these rows and wires the callbacks by (regionIdx, side,
 * lineIdx). Mirrors the reference design's `buildLineEditor`.
 */
export function buildLineEditor(
  regions: Region[],
  selectionFor: (idx: number) => LineSelection,
): LineEditor {
  const aRows: PaneRow[] = [];
  const bRows: PaneRow[] = [];
  const outRows: OutputRow[] = [];
  let aNo = 0;
  let bNo = 0;
  let oNo = 0;
  let conflictNo = 0;
  let aTot = 0;
  let aSel = 0;
  let bTot = 0;
  let bSel = 0;

  regions.forEach((region, idx) => {
    if (region.kind === "ctx") {
      region.lines.forEach((line) => {
        const tokens = tokenize(line);
        aRows.push(ctxRow(++aNo, tokens, "a", idx));
        bRows.push(ctxRow(++bNo, tokens, "b", idx));
        outRows.push({ kind: "line", no: ++oNo, tokens, side: "a", regionIdx: idx, lineIdx: -1, removable: false });
      });
      return;
    }

    conflictNo += 1;
    const sel = selectionFor(idx);
    const aAll = region.ours.length > 0 && region.ours.every((_, i) => sel.has(`a:${i}`));
    const aSome = region.ours.some((_, i) => sel.has(`a:${i}`));
    const bAll = region.theirs.length > 0 && region.theirs.every((_, i) => sel.has(`b:${i}`));
    const bSome = region.theirs.some((_, i) => sel.has(`b:${i}`));

    region.ours.forEach((line, i) => {
      aTot += 1;
      const picked = sel.has(`a:${i}`);
      if (picked) aSel += 1;
      aRows.push({
        no: ++aNo, tokens: tokenize(line), conflict: true, picked, side: "a", regionIdx: idx,
        lineIdx: i, blockFirst: i === 0, blockAll: aAll, blockSome: aSome && !aAll,
      });
    });
    region.theirs.forEach((line, i) => {
      bTot += 1;
      const picked = sel.has(`b:${i}`);
      if (picked) bSel += 1;
      bRows.push({
        no: ++bNo, tokens: tokenize(line), conflict: true, picked, side: "b", regionIdx: idx,
        lineIdx: i, blockFirst: i === 0, blockAll: bAll, blockSome: bSome && !bAll,
      });
    });

    const picks: { line: string; side: "a" | "b"; i: number }[] = [];
    region.ours.forEach((line, i) => {
      if (sel.has(`a:${i}`)) picks.push({ line, side: "a", i });
    });
    region.theirs.forEach((line, i) => {
      if (sel.has(`b:${i}`)) picks.push({ line, side: "b", i });
    });
    if (picks.length === 0) {
      outRows.push({ kind: "placeholder", conflictNo, regionIdx: idx });
    } else {
      picks.forEach((p) =>
        outRows.push({
          kind: "line", no: ++oNo, tokens: tokenize(p.line), side: p.side,
          regionIdx: idx, lineIdx: p.i, removable: true,
        }),
      );
    }
  });

  return {
    aRows,
    bRows,
    outRows,
    aAll: aTot > 0 && aSel === aTot,
    aSome: aSel > 0 && aSel < aTot,
    bAll: bTot > 0 && bSel === bTot,
    bSome: bSel > 0 && bSel < bTot,
  };
}

function ctxRow(no: number, tokens: Token[], side: "a" | "b", regionIdx: number): PaneRow {
  return { no, tokens, conflict: false, picked: false, side, regionIdx, lineIdx: -1, blockFirst: false, blockAll: false, blockSome: false };
}

const KEYWORDS = new Set([
  "import", "from", "const", "let", "var", "function", "export", "type", "as", "return",
  "if", "else", "void", "new", "true", "false", "await", "async", "interface", "extends",
  "null", "class", "for", "while", "switch", "case", "break", "continue", "default", "this",
]);

const TOKEN_CLASS: Record<string, string> = {
  plain: "text-neutral-700 dark:text-neutral-200",
  kw: "text-violet-600 dark:text-violet-400",
  str: "text-amber-600 dark:text-amber-400",
  com: "text-neutral-400 italic",
  num: "text-teal-600 dark:text-teal-400",
  type: "text-sky-600 dark:text-sky-400",
  punct: "text-neutral-500 dark:text-neutral-400",
};

const TOKEN_RE =
  /(\s+)|(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\d+(?:\.\d+)?)|([A-Za-z_$][A-Za-z0-9_$]*)|([^\sA-Za-z0-9_$])/g;

/** Lightweight, language-agnostic syntax tokenization for a single code line —
 * good enough to give conflict hunks the same readable colouring as the diff
 * viewer without pulling in a full highlighter. */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(line))) {
    let cls = "plain";
    let value: string;
    if (match[1]) {
      cls = "plain";
      value = match[1];
    } else if (match[2]) {
      cls = "com";
      value = match[2];
    } else if (match[3]) {
      cls = "str";
      value = match[3];
    } else if (match[4]) {
      cls = "num";
      value = match[4];
    } else if (match[5]) {
      value = match[5];
      cls = KEYWORDS.has(value) ? "kw" : /^[A-Z]/.test(value) ? "type" : "plain";
    } else {
      cls = "punct";
      value = match[6];
    }
    out.push({ v: value, cls: TOKEN_CLASS[cls] });
  }
  if (out.length === 0) out.push({ v: " ", cls: "" });
  return out;
}
