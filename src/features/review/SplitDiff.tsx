// The split (side-by-side) diff view: SplitDiff renders the virtualized rows,
// SplitLine one left/right pair, SplitHalf one pane. The three change together
// (one axis: split-layout rendering), so they share this file (GL-162).

import { useMemo, type ReactNode } from "react";
import type { DiffLine, FileDiff } from "../../lib/api";
import { cn } from "../../lib/cn";
import { HunkCardHeader, LineStageButton, MONO, numCell, Tokens } from "./DiffBody";
import {
  buildLineMeta,
  CommentCard,
  CommentEditor,
  CommentHandle,
  useLineComments,
  type LineCommentsController,
  type LineRowComments,
} from "./comments";
import { flattenSplit, type SplitRow } from "./diffRows";
import { splitTones } from "./diffTones";
import { hunkBody, hunkStaging, type HunkActionApi } from "./hunkActions";
import { ChangeMinimap } from "./ChangeMinimap";
import { FullDiffNotice } from "./FullDiffNotice";
import { VirtualDiffList } from "./VirtualDiffList";

export function SplitDiff({
  file,
  hunkAction,
  surface,
}: {
  file: FileDiff;
  hunkAction: HunkActionApi | null;
  surface: string;
}) {
  const rows = useMemo(() => flattenSplit(file.hunks), [file.hunks]);
  const tones = useMemo(() => splitTones(file.hunks), [file.hunks]);
  // One controller over the file's lines (same seq space as unified, so a
  // mixed-side range like L12–R12 still resolves). Each half resolves its own
  // line's seq; `confineDragToSide` keeps a drag within the column it started on.
  const lines = useMemo(() => buildLineMeta(file.hunks), [file.hunks]);
  const comments = useLineComments(surface, file.path, lines, { confineDragToSide: true });
  const { unavailableReason, lineUnavailable, mode } = hunkStaging(file, hunkAction);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <VirtualDiffList
          rows={rows}
          getKey={(row) => row.key}
          testId="review-split-scroll"
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
              <SplitLine
                row={row.row}
                hunkIndex={row.hunkIndex}
                controller={comments}
                left={row.leftSeq != null ? comments.rowFor(row.leftSeq) : null}
                right={row.rightSeq != null ? comments.rowFor(row.rightSeq) : null}
                lineStage={
                  hunkAction && !lineUnavailable ? { mode, onApply: hunkAction.onApplyLine } : null
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

function SplitLine({
  row,
  hunkIndex,
  lineStage,
  controller,
  left,
  right,
}: {
  row: SplitRow;
  hunkIndex: number;
  lineStage: {
    mode: "stage" | "unstage";
    onApply: (hunkIndex: number, lineIndex: number, line: DiffLine) => void;
  } | null;
  controller: LineCommentsController;
  left?: LineRowComments | null;
  right?: LineRowComments | null;
}) {
  const { left: leftCell, right: rightCell } = row;
  return (
    <div>
      <div className="flex" style={{ fontFamily: MONO, fontSize: "12.5px", lineHeight: "19px", minHeight: "19px" }}>
        <SplitHalf
          no={leftCell?.line.oldNo ?? null}
          content={leftCell ? leftCell.line.content : null}
          tone={leftCell?.line.kind === "del" ? "del" : "ctx"}
          comments={left}
          action={
            leftCell && leftCell.line.kind === "del" && lineStage ? (
              <LineStageButton
                stage={{
                  mode: lineStage.mode,
                  onClick: () => lineStage.onApply(hunkIndex, leftCell.lineIndex, leftCell.line),
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2"
              />
            ) : null
          }
          border
        />
        <SplitHalf
          no={rightCell?.line.newNo ?? null}
          content={rightCell ? rightCell.line.content : null}
          tone={rightCell?.line.kind === "add" ? "add" : "ctx"}
          comments={right}
          action={
            rightCell && rightCell.line.kind === "add" && lineStage ? (
              <LineStageButton
                stage={{
                  mode: lineStage.mode,
                  onClick: () => lineStage.onApply(hunkIndex, rightCell.lineIndex, rightCell.line),
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2"
              />
            ) : null
          }
        />
      </div>
      {/* Each side's editor/card renders below the row, indented under that half;
       * the scope label ("Comment on line L4 / R20") names the side. */}
      {left?.editHere ? (
        <CommentEditor scope={left.scope} controller={controller} indent="ml-[46px] mr-3" />
      ) : null}
      {left?.showCard ? (
        <CommentCard scope={left.scope} body={left.body} onEdit={left.edit} onDelete={left.remove} indent="ml-[46px] mr-3" />
      ) : null}
      {right?.editHere ? (
        <CommentEditor scope={right.scope} controller={controller} indent="ml-[50%] mr-3" />
      ) : null}
      {right?.showCard ? (
        <CommentCard scope={right.scope} body={right.body} onEdit={right.edit} onDelete={right.remove} indent="ml-[50%] mr-3" />
      ) : null}
    </div>
  );
}

const HATCH =
  "repeating-linear-gradient(45deg, transparent 0 5px, rgba(128,128,128,0.11) 5px 6px)";

// One pane of a split row, and its own hover group (`group/line`) so hovering it
// reveals only this side's stage button + comment handle.
function SplitHalf({
  no,
  content,
  tone,
  action,
  comments,
  border,
}: {
  no: number | null;
  content: string | null;
  tone: "ctx" | "add" | "del";
  action?: ReactNode;
  comments?: LineRowComments | null;
  border?: boolean;
}) {
  const present = content != null;
  const baseBg = tone === "add" ? "rgba(46,158,98,0.11)" : tone === "del" ? "rgba(225,98,111,0.12)" : "transparent";
  // Comment selection/coverage tints this side independently of the other.
  const bg = comments?.selecting
    ? "var(--accent-soft)"
    : comments?.covered
      ? "rgba(120,120,120,0.06)"
      : baseBg;
  const gut = tone === "add" ? "#2e9e62" : tone === "del" ? "#e0626f" : "transparent";
  return (
    <div
      className={cn(
        "group/line flex min-w-0 flex-1 items-start overflow-hidden",
        border && "border-r border-black/5 dark:border-white/5",
      )}
      style={{
        background: bg,
        // Missing line on this side: diagonal hatch instead of a flat block so
        // it reads clearly as "no counterpart here".
        backgroundImage: present ? undefined : HATCH,
        borderLeft: `3px solid ${gut}`,
      }}
      onMouseEnter={comments?.onRowEnter}
    >
      {/* Stage button overlays the line number (mirrors the unified view's
       * sign-column staging); the number fades under it on hover. */}
      <span className={cn(numCell, "relative")}>
        <span className={cn(!!action && "transition-opacity group-hover/line:opacity-0")}>{no ?? ""}</span>
        {action}
      </span>
      {present ? (
        <span className="min-w-0 flex-1 overflow-hidden">
          <Tokens content={content} />
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {comments ? (
        <span className="flex flex-none items-center self-stretch pl-1 pr-2.5">
          <CommentHandle row={comments} />
        </span>
      ) : null}
    </div>
  );
}
