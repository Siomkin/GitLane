import { useMemo } from "react";
import type { FileDiff } from "@/lib/api";
import { HunkCardHeader, UnifiedLine } from "./DiffBody";
import { buildLineMeta, useLineComments } from "./comments";
import { flattenUnified } from "./diffRows";
import { unifiedTones } from "./diffTones";
import { hunkBody, hunkStaging, type HunkActionApi } from "./hunkActions";
import { ChangeMinimap } from "./ChangeMinimap";
import { FullDiffNotice } from "./FullDiffNotice";
import { VirtualDiffList } from "./VirtualDiffList";
import { GUTTER_WIDTH, type DiffGutter } from "./SplitDiff";
import { markKey, wordMarks } from "./wordMarks";

export function UnifiedDiff({
  file,
  hunkAction,
  surface,
  gutter,
  focus,
  hideHunkHeaders = false,
}: {
  file: FileDiff;
  hunkAction: HunkActionApi | null;
  surface: string;
  gutter?: DiffGutter;
  focus?: { hunkIndex: number; lineIndex: number } | null;
  /** Drop the `@@` cards — a whole-file diff is one hunk with nothing to label. */
  hideHunkHeaders?: boolean;
}) {
  const rows = useMemo(() => {
    const all = flattenUnified(file.hunks);
    return hideHunkHeaders ? all.filter((r) => r.kind !== "header") : all;
  }, [file.hunks, hideHunkHeaders]);
  const focusIndex = focus
    ? rows.findIndex(
        (r) => r.kind === "line" && r.hunkIndex === focus.hunkIndex && r.lineIndex === focus.lineIndex,
      )
    : null;
  const tones = useMemo(() => unifiedTones(file.hunks), [file.hunks]);
  const marks = useMemo(() => wordMarks(file.hunks), [file.hunks]);
  const lines = useMemo(() => buildLineMeta(file.hunks), [file.hunks]);
  const comments = useLineComments(surface, file.path, lines);
  const { unavailableReason, lineUnavailable, mode } = hunkStaging(file, hunkAction);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <VirtualDiffList
          rows={rows}
          getKey={(row) => row.key}
          testId="review-unified-scroll"
          scrollToIndex={focusIndex}
          renderRow={(row) =>
            row.kind === "header" ? (
              <HunkCardHeader
                header={row.header}
                changed={row.changed}
                stage={
                  hunkAction
                    ? {
                        mode,
                        onClick: () =>
                          hunkAction.onApply(row.hunkIndex, row.header, hunkBody(file.hunks[row.hunkIndex])),
                        disabledReason: unavailableReason,
                      }
                    : null
                }
              />
            ) : gutter ? (
              <div className="flex">
                <div className="flex flex-none items-center justify-center" style={{ width: GUTTER_WIDTH }}>
                  {gutter(row.hunkIndex, [row.lineIndex])}
                </div>
                <div className="min-w-0 flex-1">
                  <UnifiedLine
                    line={row.line}
                    comments={comments.rowFor(row.seq)}
                    controller={comments}
                    stage={null}
                    marks={marks.get(markKey(row.hunkIndex, row.lineIndex))}
                  />
                </div>
              </div>
            ) : (
              <UnifiedLine
                line={row.line}
                marks={marks.get(markKey(row.hunkIndex, row.lineIndex))}
                comments={comments.rowFor(row.seq)}
                controller={comments}
                stage={
                  hunkAction && !lineUnavailable && row.line.kind !== "ctx"
                    ? { mode, onClick: () => hunkAction.onApplyLine(row.hunkIndex, row.lineIndex, row.line) }
                    : null
                }
              />
            )
          }
        />
        <ChangeMinimap tones={tones} />
      </div>
      {file.truncated && <FullDiffNotice />}
    </div>
  );
}
