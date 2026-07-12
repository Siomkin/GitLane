// Line-level change classification for the editor/viewer gutter markers — the
// "uncommitted changes" bars (VS Code-style): a colour by the current buffer's
// lines against the committed (HEAD) baseline. Pure + dependency-free so it's
// trivially testable and cheap to run as the user types.

/** How a current line relates to the baseline. */
export const LineChange = {
  None: "none",
  Added: "added",
  Modified: "modified",
} as const;
export type LineChange = (typeof LineChange)[keyof typeof LineChange];

export interface LineChanges {
  /** Per current-line tag (length === current line count). */
  tags: LineChange[];
  /** Current-line indices that have one or more deleted baseline lines
   * immediately above them (a deletion caret is drawn at that boundary). */
  deletedBefore: Set<number>;
  /** True when a deletion happened at the very end (after the last line). */
  deletedAtEnd: boolean;
}

/** Above this size (larger side) the diff is skipped (returns all-`none`): the
 * gutter markers aren't worth a large O(N·D) diff, and the caller also caps
 * rendering. Using the larger side (not the sum) keeps a normal edit of a file
 * just under the render cap from being suppressed. */
const MAX_DIFF_LINES = 20_000;

/** Hard ceiling on the memory the Myers frontier snapshots may use, so a
 * high-edit-distance diff bails (→ no markers) long before it can freeze or
 * exhaust the webview. Each snapshot is `(2·(n+m)+1)` Int32s, so this naturally
 * allows a large edit distance on small files and a small one on big files. */
const MAX_TRACE_BYTES = 8 * 1024 * 1024; // 8 MiB

type Op = "eq" | "del" | "ins";

/**
 * Myers O(ND) diff over two line arrays, returning the edit script as a flat op
 * list (`eq` advances both, `del` drops a baseline line, `ins` adds a current
 * line). Bails to `null` when the edit distance exceeds `maxD`, or when the
 * frontier snapshots would exceed the memory budget, so a wholesale rewrite
 * can't spend unbounded time or memory.
 */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return []; // both empty — no edits (keeps the frontier valid)
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  const snapshotBytes = v.length * 4;

  for (let d = 0; d <= Math.min(max, maxD); d++) {
    if ((trace.length + 1) * snapshotBytes > MAX_TRACE_BYTES) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // down (insertion)
      } else {
        x = v[offset + k - 1] + 1; // right (deletion)
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset, d);
      }
    }
  }
  return null; // exceeded maxD
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, d0: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = d0; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("eq");
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push("ins");
      y--;
    } else {
      ops.push("del");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("eq");
    x--;
    y--;
  }
  ops.reverse();
  return ops;
}

const empty = (curLen: number): LineChanges => ({
  tags: new Array(curLen).fill(LineChange.None),
  deletedBefore: new Set(),
  deletedAtEnd: false,
});

/** Line count of `text` without allocating the lines (1 + newline count). */
export function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * Change classification straight from the two texts. Counts lines *cheaply*
 * first and only materializes the line arrays when both are within the cap — so
 * a multi-megabyte, newline-dense file can't allocate hundreds of thousands of
 * strings just to be rejected by {@link computeLineChanges}.
 */
export function computeLineChangesText(base: string | null, cur: string): LineChanges {
  const curCount = countLines(cur);
  if (base === null) return empty(curCount);
  if (Math.max(countLines(base), curCount) > MAX_DIFF_LINES) return empty(curCount);
  return computeLineChanges(base.split("\n"), cur.split("\n"));
}

/**
 * Classify each current line against `base` (the committed baseline).
 * `base === null` (no baseline: untracked/binary/unborn) yields no markers.
 * A run of deletions immediately followed by insertions is coalesced into
 * "modified"; surplus insertions are "added"; surplus/standalone deletions
 * become a deletion caret at the boundary.
 */
export function computeLineChanges(base: string[] | null, cur: string[]): LineChanges {
  if (base === null || Math.max(base.length, cur.length) > MAX_DIFF_LINES) return empty(cur.length);

  const ops = myers(base, cur, Math.min(base.length + cur.length, 4000));
  if (ops === null) return empty(cur.length);

  const tags: LineChange[] = new Array(cur.length).fill(LineChange.None);
  const deletedBefore = new Set<number>();
  let deletedAtEnd = false;

  let ci = 0; // current-line cursor
  let pendingDel = 0; // deletions seen but not yet paired with insertions
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op === "del") {
      pendingDel++;
      i++;
    } else if (op === "ins") {
      // Pair this insertion with an outstanding deletion → modified; else added.
      tags[ci] = pendingDel > 0 ? LineChange.Modified : LineChange.Added;
      if (pendingDel > 0) pendingDel--;
      ci++;
      i++;
    } else {
      // eq: any deletions not paired with an insertion are a pure removal at
      // this boundary (just above the current line).
      if (pendingDel > 0) {
        deletedBefore.add(ci);
        pendingDel = 0;
      }
      ci++;
      i++;
    }
  }
  // Deletions trailing the last op (nothing after them) sit at the end.
  if (pendingDel > 0) {
    if (ci >= cur.length) deletedAtEnd = true;
    else deletedBefore.add(ci);
  }

  return { tags, deletedBefore, deletedAtEnd };
}
