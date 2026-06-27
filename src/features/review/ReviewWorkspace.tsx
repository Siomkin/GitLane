import { type ReactNode, useMemo, useState } from "react";
import type { DiffHunk, DiffLine, FileDiff } from "../../lib/api";
import { cn } from "../../lib/cn";
import { basename, dirname } from "../../lib/paths";
import { useRepo } from "../../store/repo";
import { FileIcon } from "@/components/ui/icons";
import {
  DiffTruncatedNotice,
  HunkCardHeader,
  LineStageButton,
  MONO,
  numCell,
  Tokens,
  UnifiedLine,
} from "./DiffBody";
import {
  buildColumnLineMeta,
  buildLineMeta,
  CommentCard,
  CommentEditor,
  CommentHandle,
  HandToAgentBar,
  useLineComments,
  type LineCommentsController,
  type LineRowComments,
} from "./comments";
import { flattenSplit, flattenUnified, toSplitRows, type SplitRow } from "./diffRows";
import { hunkPatchUnavailableReason } from "./hunkActions";
import { VirtualDiffList } from "./VirtualDiffList";
import { StatusPill } from "@/components/ui/StatusBadge";

type DiffMode = "split" | "unified";

/** Stage/unstage callbacks for the open file's diff. Null for committed diffs,
 * which can't be staged. */
type HunkActionApi = {
  source: "unstaged" | "staged";
  onApply: (hunkIndex: number, expectedHeader: string) => void;
  onApplyLine: (hunkIndex: number, lineIndex: number, line: DiffLine) => void;
};

export function ReviewWorkspace({ onBack }: { onBack?: () => void }) {
  const fileDiff = useRepo((state) => state.fileDiff);
  const diffLoading = useRepo((state) => state.diffLoading);
  const selectedFile = useRepo((state) => state.selectedFile);
  const applyHunk = useRepo((state) => state.applyHunk);
  const applyLine = useRepo((state) => state.applyLine);
  const clearSelectedFile = useRepo((state) => state.clearSelectedFile);
  const [mode, setMode] = useState<DiffMode>("unified");
  const hunkAction =
    selectedFile && selectedFile.source !== "commit"
      ? {
          source: selectedFile.source,
          onApply: (hunkIndex: number, expectedHeader: string) =>
            applyHunk(selectedFile.path, selectedFile.source === "staged", hunkIndex, expectedHeader),
          onApplyLine: (hunkIndex: number, lineIndex: number, line: DiffLine) =>
            applyLine(selectedFile.path, selectedFile.source === "staged", hunkIndex, lineIndex, line),
        }
      : null;

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 dark:border-white/5 bg-white dark:bg-neutral-800 shadow-sm">
      <ReviewHeader file={fileDiff} mode={mode} onModeChange={setMode} onBack={onBack ?? clearSelectedFile} />

      {diffLoading ? (
        <EmptyDiff title="Loading diff" />
      ) : !fileDiff ? (
        <EmptyDiff title="Select a file to view its diff" />
      ) : fileDiff.binary ? (
        <EmptyDiff title="Binary file" />
      ) : mode === "split" ? (
        <SplitDiff file={fileDiff} hunkAction={hunkAction} />
      ) : (
        <UnifiedDiff file={fileDiff} hunkAction={hunkAction} />
      )}

      <HandToAgentBar />
    </main>
  );
}

function ReviewHeader({
  file,
  mode,
  onModeChange,
  onBack,
}: {
  file: FileDiff | null;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex h-12 flex-none items-center gap-2.5 border-b border-black/5 dark:border-white/5 px-4">
      {file && (
        <>
          <span className="text-[color:var(--accent)]">
            <FileIcon path={file.path} size={20} />
          </span>
          <span className="text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">{basename(file.path)}</span>
          <span className="min-w-0 truncate text-[12px] text-neutral-400">{dirname(file.path)}</span>
          <StatusPill status={file.status} />
          <span className="font-mono text-xs text-[color:var(--accent)]">+{file.add}</span>
          <span className="font-mono text-xs text-rose-500">−{file.del}</span>
        </>
      )}
      <div className="ml-auto flex p-0.5 rounded-lg bg-black/[0.06] dark:bg-white/[0.06] text-[12px]">
        <button className={modeButton(mode === "unified")} onClick={() => onModeChange("unified")}>
          Unified
        </button>
        <button className={modeButton(mode === "split")} onClick={() => onModeChange("split")}>
          Split
        </button>
      </div>
      <button
        className="flex items-center gap-1 h-8 px-2.5 rounded-lg border border-black/10 dark:border-white/10 text-[12px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5"
        onClick={onBack}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Graph
      </button>
    </div>
  );
}

function modeButton(active: boolean) {
  return cn(
    "px-2.5 h-6 rounded-md",
    active
      ? "bg-white dark:bg-neutral-700 shadow-sm font-medium text-neutral-800 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );
}

// "Show full diff" footer for a backend-truncated diff. Reads the store action
// directly so both diff modes can drop it in without prop-threading.
function FullDiffNotice() {
  const loadFullFileDiff = useRepo((state) => state.loadFullFileDiff);
  const diffLoading = useRepo((state) => state.diffLoading);
  return <DiffTruncatedNotice onShowFull={loadFullFileDiff} loading={diffLoading} />;
}

function UnifiedDiff({ file, hunkAction }: { file: FileDiff; hunkAction: HunkActionApi | null }) {
  const rows = useMemo(() => flattenUnified(file.hunks), [file.hunks]);
  const tones = useMemo(() => unifiedTones(file.hunks), [file.hunks]);
  const lines = useMemo(() => buildLineMeta(file.hunks), [file.hunks]);
  const comments = useLineComments(file.path, lines);
  const unavailableReason = hunkAction ? hunkPatchUnavailableReason(file, hunkAction.source) : null;
  const mode: "stage" | "unstage" = hunkAction?.source === "staged" ? "unstage" : "stage";
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
                        onClick: () => hunkAction.onApply(row.hunkIndex, row.header),
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
                  hunkAction && !unavailableReason && row.line.kind !== "ctx"
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

function SplitDiff({ file, hunkAction }: { file: FileDiff; hunkAction: HunkActionApi | null }) {
  const rows = useMemo(() => flattenSplit(file.hunks), [file.hunks]);
  const tones = useMemo(() => splitTones(file.hunks), [file.hunks]);
  // Each column is commented independently: the old (L) side and new (R) side
  // get their own controller, so hovering one half reveals only that half's
  // stage + comment affordances.
  const leftLines = useMemo(() => buildColumnLineMeta(file.hunks, "L"), [file.hunks]);
  const rightLines = useMemo(() => buildColumnLineMeta(file.hunks, "R"), [file.hunks]);
  const leftComments = useLineComments(file.path, leftLines);
  const rightComments = useLineComments(file.path, rightLines);
  const unavailableReason = hunkAction ? hunkPatchUnavailableReason(file, hunkAction.source) : null;
  const mode: "stage" | "unstage" = hunkAction?.source === "staged" ? "unstage" : "stage";
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
                        onClick: () => hunkAction.onApply(row.hunkIndex, row.header),
                        disabledReason: unavailableReason,
                      }
                    : null
                }
              />
            ) : (
              <SplitLine
                row={row.row}
                hunkIndex={row.hunkIndex}
                left={row.leftSeq != null ? leftComments.rowFor(row.leftSeq) : null}
                right={row.rightSeq != null ? rightComments.rowFor(row.rightSeq) : null}
                leftController={leftComments}
                rightController={rightComments}
                lineStage={
                  hunkAction && !unavailableReason ? { mode, onApply: hunkAction.onApplyLine } : null
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
  left,
  right,
  leftController,
  rightController,
}: {
  row: SplitRow;
  hunkIndex: number;
  lineStage: {
    mode: "stage" | "unstage";
    onApply: (hunkIndex: number, lineIndex: number, line: DiffLine) => void;
  } | null;
  left?: LineRowComments | null;
  right?: LineRowComments | null;
  leftController?: LineCommentsController | null;
  rightController?: LineCommentsController | null;
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
      {left?.editHere && leftController ? (
        <CommentEditor scope={left.scope} controller={leftController} indent="ml-[46px] mr-3" />
      ) : null}
      {left?.showCard ? (
        <CommentCard scope={left.scope} body={left.body} onEdit={left.edit} onDelete={left.remove} indent="ml-[46px] mr-3" />
      ) : null}
      {right?.editHere && rightController ? (
        <CommentEditor scope={right.scope} controller={rightController} indent="ml-[50%] mr-3" />
      ) : null}
      {right?.showCard ? (
        <CommentCard scope={right.scope} body={right.body} onEdit={right.edit} onDelete={right.remove} indent="ml-[50%] mr-3" />
      ) : null}
    </div>
  );
}

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

const HATCH =
  "repeating-linear-gradient(45deg, transparent 0 5px, rgba(128,128,128,0.11) 5px 6px)";

type Tone = "add" | "del" | "ctx" | "header";

function unifiedTones(hunks: DiffHunk[]): Tone[] {
  const out: Tone[] = [];
  for (const hunk of hunks) {
    out.push("header");
    for (const line of hunk.lines) out.push(line.kind);
  }
  return out;
}

function splitTones(hunks: DiffHunk[]): Tone[] {
  const out: Tone[] = [];
  for (const hunk of hunks) {
    out.push("header");
    for (const row of toSplitRows(hunk.lines)) {
      out.push(row.right?.line.kind === "add" ? "add" : row.left?.line.kind === "del" ? "del" : "ctx");
    }
  }
  return out;
}

// Condensed change overview pinned to the right edge of the scroll area, so the
// changed regions of a long file are visible at a glance. Positions are
// fractions of the rendered row count, matching the scroll height.
function ChangeMinimap({ tones }: { tones: Tone[] }) {
  const total = tones.length;
  if (!total) return null;
  const bands: { start: number; len: number; tone: "add" | "del" }[] = [];
  for (let i = 0; i < total; i++) {
    const t = tones[i];
    if (t !== "add" && t !== "del") continue;
    const last = bands[bands.length - 1];
    if (last && last.tone === t && last.start + last.len === i) last.len++;
    else bands.push({ start: i, len: 1, tone: t });
  }
  if (!bands.length) return null;
  return (
    <div className="pointer-events-none absolute right-0 top-0 h-full w-2.5 border-l border-black/5 dark:border-white/5 bg-black/[0.03] dark:bg-white/[0.04]">
      {bands.map((band, i) => (
        <div
          key={i}
          className="absolute inset-x-[1px] rounded-[1px]"
          style={{
            top: `${(band.start / total) * 100}%`,
            height: `${Math.max((band.len / total) * 100, 0.5)}%`,
            background: band.tone === "add" ? "#2e9e62" : "#f43f5e",
            opacity: 0.45,
          }}
        />
      ))}
    </div>
  );
}

function EmptyDiff({ title }: { title: string }) {
  return <div className="grid min-h-0 flex-1 place-content-center text-sm text-neutral-400">{title}</div>;
}
