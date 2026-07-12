// Per-row tone sequences for the change minimap (GL-162 split out of
// ReviewWorkspace.tsx): one entry per rendered row — header, add, del, or ctx —
// in the same order the unified/split views paint them, so minimap positions
// match the scroll height. Pure.

import type { DiffHunk } from "@/lib/api";
import { toSplitRows } from "./diffRows";

export type Tone = "add" | "del" | "ctx" | "header";

export function unifiedTones(hunks: DiffHunk[]): Tone[] {
  const out: Tone[] = [];
  for (const hunk of hunks) {
    out.push("header");
    for (const line of hunk.lines) out.push(line.kind);
  }
  return out;
}

export function splitTones(hunks: DiffHunk[]): Tone[] {
  const out: Tone[] = [];
  for (const hunk of hunks) {
    out.push("header");
    for (const row of toSplitRows(hunk.lines)) {
      out.push(row.right?.line.kind === "add" ? "add" : row.left?.line.kind === "del" ? "del" : "ctx");
    }
  }
  return out;
}
