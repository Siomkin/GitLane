// Pure logic + tokens for the uncommitted-change decorations (GL-212), split out
// of changeMarkers.tsx so that component file exports only components (keeps Fast
// Refresh able to preserve state — react-doctor `only-export-components`).

import { LineChange, type LineChanges } from "./lineChanges";

// Gutter colours. Added stays green; modified is a neutral (cursor-toned) grey
// with a hatched stripe rather than a loud blue; deletions are a red caret.
export const ADD_COLOR = "#2e9e62";
export const MOD_COLOR = "#9ca3af"; // neutral grey, close to the caret tone (not blue)
export const DELETE_CARET = "#e0626f";

/** Diagonal hatch used for modified runs. */
export const stripes = (color: string) =>
  `repeating-linear-gradient(45deg, ${color} 0, ${color} 1.5px, transparent 1.5px, transparent 4px)`;

/** Per-line gutter fill for a change tag (solid green added, neutral striped
 * modified), or null for an unchanged line. */
export const barFill = (tag: LineChange): string | null =>
  tag === LineChange.Added ? ADD_COLOR : tag === LineChange.Modified ? stripes(MOD_COLOR) : null;

/** One block on the overview ruler: a fraction (0–1) of the file height + fill.
 * `deletion` marks are drawn as a thin caret rather than a proportional block. */
export interface RulerMark {
  top: number;
  height: number;
  /** CSS background (solid colour or a stripe gradient). */
  fill: string;
  deletion: boolean;
}

/** Opacity applied to every ruler mark (matches the review view's ChangeMinimap). */
export const RULER_OPACITY = 0.45;

// Ruler fills match the review view's ChangeMinimap so the whole app reads as one
// system: the same green / rose. Modified has no minimap analogue, so it uses the
// neutral grey (solid at this small scale — the gutter carries the hatch).
const RULER_ADD = "#2e9e62";
const RULER_DEL = "#f43f5e";
const RULER_MOD = "#9ca3af";

/** Collapse the per-line changes into ruler blocks: runs of the same tag merge
 * into one proportional block; each deletion is a point. Positions are fractions
 * of the whole file so the ruler maps the entire document onto its own height. */
export function rulerMarksFrom(changes: LineChanges | null, lineCount: number): RulerMark[] {
  if (!changes || lineCount === 0) return [];
  const marks: RulerMark[] = [];
  let i = 0;
  while (i < lineCount) {
    const tag = changes.tags[i] ?? LineChange.None;
    if (tag === LineChange.None) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lineCount && changes.tags[j + 1] === tag) j++;
    const fill = tag === LineChange.Modified ? RULER_MOD : RULER_ADD;
    marks.push({ top: i / lineCount, height: (j - i + 1) / lineCount, fill, deletion: false });
    i = j + 1;
  }
  for (const idx of changes.deletedBefore) {
    marks.push({ top: idx / lineCount, height: 0, fill: RULER_DEL, deletion: true });
  }
  if (changes.deletedAtEnd) marks.push({ top: 1, height: 0, fill: RULER_DEL, deletion: true });
  return marks;
}
