// Pair each removed line with the added line that replaces it — the k-th of
// each in a change run, the same pairing the split view lays out side by side
// (`flattenSplit`) — and record the words that changed on both.

import type { DiffHunk } from "@/lib/api";
import { wordDiff, type CharRange } from "@/lib/wordDiff";

/** Key of one hunk line in a {@link WordMarks} map. */
export const markKey = (hunkIndex: number, lineIndex: number) => `${hunkIndex}:${lineIndex}`;

export type WordMarks = Map<string, CharRange[]>;

export function wordMarks(hunks: DiffHunk[]): WordMarks {
  const marks: WordMarks = new Map();
  hunks.forEach((hunk, h) => {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === "ctx") {
        i++;
        continue;
      }
      const dels: number[] = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(i++);
      const adds: number[] = [];
      while (i < lines.length && lines[i].kind === "add") adds.push(i++);
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const pair = wordDiff(lines[dels[k]].content, lines[adds[k]].content);
        if (!pair) continue;
        if (pair.a.length) marks.set(markKey(h, dels[k]), pair.a);
        if (pair.b.length) marks.set(markKey(h, adds[k]), pair.b);
      }
    }
  });
  return marks;
}
