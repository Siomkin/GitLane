// The per-line editor model — the pane rows a region expands into when the
// user picks individual lines rather than a whole side.

import type {
  LineEditor,
  LineSelection,
  OutputRow,
  PaneRow,
  Region,
  Token,
} from "./types";
import { tokenize } from "./tokenize";

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
  /** Custom (rewritten) lines for a hunk, when it was resolved that way. */
  customFor: (idx: number) => string[] | undefined = () => undefined,
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
        outRows.push({
          kind: "line", no: ++oNo, text: line, tokens, side: "a",
          regionIdx: idx, lineIdx: -1, removable: false,
        });
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

    // A custom resolution owns the hunk's output — including an empty one,
    // which is a deliberate "drop both sides", not an undecided hunk.
    const custom = customFor(idx);
    if (custom) {
      custom.forEach((line, i) =>
        outRows.push({
          kind: "line", no: ++oNo, text: line, tokens: tokenize(line), side: "ai",
          regionIdx: idx, lineIdx: i, removable: false,
        }),
      );
      if (custom.length === 0) {
        outRows.push({ kind: "placeholder", conflictNo, regionIdx: idx, dropped: true });
      }
      return;
    }

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
          kind: "line", no: ++oNo, text: p.line, tokens: tokenize(p.line), side: p.side,
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
