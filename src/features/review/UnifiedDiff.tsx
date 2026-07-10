import { useMemo } from "react";
import type { FileDiff } from "../../lib/api";
import { HunkCardHeader, UnifiedLine } from "./DiffBody";
import { buildLineMeta, useLineComments } from "./comments";
import { flattenUnified } from "./diffRows";
import { unifiedTones } from "./diffTones";
import { hunkBody, hunkStaging, type HunkActionApi } from "./hunkActions";
import { ChangeMinimap } from "./ChangeMinimap";
import { FullDiffNotice } from "./FullDiffNotice";
import { VirtualDiffList } from "./VirtualDiffList";

export function UnifiedDiff({
  file,
  hunkAction,
  surface,
}: {
  file: FileDiff;
  hunkAction: HunkActionApi | null;
  surface: string;
}) {
  const rows = useMemo(() => flattenUnified(file.hunks), [file.hunks]);
  const tones = useMemo(() => unifiedTones(file.hunks), [file.hunks]);
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
            ) : (
              <UnifiedLine
                line={row.line}
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
