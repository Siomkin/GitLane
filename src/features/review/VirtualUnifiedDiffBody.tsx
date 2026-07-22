// Windowed counterpart to `UnifiedDiffBody` (GL-234): the same hunk-card rows,
// routed through `VirtualDiffList` so a huge file mounts only its visible rows
// instead of every line at once. "Show full diff" on a 50k-line lockfile used to
// build that whole tree as raw DOM.
//
// Deliberately narrower than `UnifiedDiff`: no hunk staging and no line comments,
// because the read-only panes that use this (file history, compare) offer
// neither. `UnifiedDiffBody` stays for surfaces that render inline inside a
// page-level scroller and so cannot own a scroll container.
//
// Requires a positioned, bounded parent — `VirtualDiffList` fills it with
// `absolute inset-0` and owns the scrolling itself.

import { useMemo } from "react";
import type { DiffHunk } from "@/lib/api";
import { HunkCardHeader, UnifiedLine } from "./DiffBody";
import { flattenUnified } from "./diffRows";
import { VirtualDiffList } from "./VirtualDiffList";

export function VirtualUnifiedDiffBody({
  hunks,
  testId,
}: {
  hunks: DiffHunk[];
  testId?: string;
}) {
  const rows = useMemo(() => flattenUnified(hunks), [hunks]);
  return (
    <VirtualDiffList
      rows={rows}
      getKey={(row) => row.key}
      testId={testId}
      renderRow={(row) =>
        row.kind === "header" ? (
          <HunkCardHeader header={row.header} changed={row.changed} />
        ) : (
          <UnifiedLine line={row.line} />
        )
      }
    />
  );
}
