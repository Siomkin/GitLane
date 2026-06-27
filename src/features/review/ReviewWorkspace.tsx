import { type ReactNode, useMemo, useState } from "react";
import type { DiffHunk, DiffLine, FileDiff } from "../../lib/api";
import { cn } from "../../lib/cn";
import { basename, dirname } from "../../lib/paths";
import { useRepo } from "../../store/repo";
import { FileIcon } from "@/components/ui/icons";
import {
  DiffTruncatedNotice,
  HunkActionButton,
  HunkHeader,
  LineActionButton,
  MONO,
  numCell,
  Tokens,
  UnifiedLine,
} from "./DiffBody";
import { flattenSplit, flattenUnified, toSplitRows, type SplitRow } from "./diffRows";
import { hunkPatchUnavailableReason } from "./hunkActions";
import { VirtualDiffList } from "./VirtualDiffList";
import { StatusPill } from "@/components/ui/StatusBadge";

type DiffMode = "split" | "unified";

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

function UnifiedDiff({
  file,
  hunkAction,
}: {
  file: FileDiff;
  hunkAction: {
    source: "unstaged" | "staged";
    onApply: (hunkIndex: number, expectedHeader: string) => void;
    onApplyLine: (hunkIndex: number, lineIndex: number, line: DiffLine) => void;
  } | null;
}) {
  const rows = useMemo(() => flattenUnified(file.hunks), [file.hunks]);
  const tones = useMemo(() => unifiedTones(file.hunks), [file.hunks]);
  const unavailableReason = hunkAction ? hunkPatchUnavailableReason(file, hunkAction.source) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <VirtualDiffList
          rows={rows}
          getKey={(row) => row.key}
          testId="review-unified-scroll"
          renderRow={(row) =>
            row.kind === "header" ? (
              <HunkHeader
                header={row.header}
                action={
                  hunkAction ? (
                    <HunkActionButton
                      label={hunkAction.source === "staged" ? "Unstage hunk" : "Stage hunk"}
                      unavailableReason={unavailableReason}
                      onClick={() => hunkAction.onApply(row.hunkIndex, row.header)}
                    />
                  ) : null
                }
              />
            ) : (
              <UnifiedLine
                line={row.line}
                file={file.path}
                action={
                  hunkAction && !unavailableReason && row.line.kind !== "ctx" ? (
                    <LineActionButton
                      label={hunkAction.source === "staged" ? "Unstage line" : "Stage line"}
                      onClick={() => hunkAction.onApplyLine(row.hunkIndex, row.lineIndex, row.line)}
                    />
                  ) : null
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

function SplitDiff({
  file,
  hunkAction,
}: {
  file: FileDiff;
  hunkAction: {
    source: "unstaged" | "staged";
    onApply: (hunkIndex: number, expectedHeader: string) => void;
    onApplyLine: (hunkIndex: number, lineIndex: number, line: DiffLine) => void;
  } | null;
}) {
  const rows = useMemo(() => flattenSplit(file.hunks), [file.hunks]);
  const tones = useMemo(() => splitTones(file.hunks), [file.hunks]);
  const unavailableReason = hunkAction ? hunkPatchUnavailableReason(file, hunkAction.source) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <VirtualDiffList
          rows={rows}
          getKey={(row) => row.key}
          testId="review-split-scroll"
          renderRow={(row) =>
            row.kind === "header" ? (
              <HunkHeader
                header={row.header}
                action={
                  hunkAction ? (
                    <HunkActionButton
                      label={hunkAction.source === "staged" ? "Unstage hunk" : "Stage hunk"}
                      unavailableReason={unavailableReason}
                      onClick={() => hunkAction.onApply(row.hunkIndex, row.header)}
                    />
                  ) : null
                }
              />
            ) : (
              <SplitLine
                row={row.row}
                hunkIndex={row.hunkIndex}
                lineAction={
                  hunkAction && !unavailableReason
                    ? {
                        label: hunkAction.source === "staged" ? "Unstage line" : "Stage line",
                        onApply: hunkAction.onApplyLine,
                      }
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

function SplitLine({
  row,
  hunkIndex,
  lineAction,
}: {
  row: SplitRow;
  hunkIndex: number;
  lineAction: {
    label: string;
    onApply: (hunkIndex: number, lineIndex: number, line: DiffLine) => void;
  } | null;
}) {
  const { left, right } = row;
  return (
    <div
      className="group/line flex"
      style={{ fontFamily: MONO, fontSize: "12.5px", lineHeight: "19px", minHeight: "19px" }}
    >
      <SplitHalf
        no={left?.line.oldNo ?? null}
        content={left ? left.line.content : null}
        tone={left?.line.kind === "del" ? "del" : "ctx"}
        action={
          left && left.line.kind === "del" && lineAction ? (
            <LineActionButton
              label={lineAction.label}
              onClick={() => lineAction.onApply(hunkIndex, left.lineIndex, left.line)}
            />
          ) : null
        }
        border
      />
      <SplitHalf
        no={right?.line.newNo ?? null}
        content={right ? right.line.content : null}
        tone={right?.line.kind === "add" ? "add" : "ctx"}
        action={
          right && right.line.kind === "add" && lineAction ? (
            <LineActionButton
              label={lineAction.label}
              onClick={() => lineAction.onApply(hunkIndex, right.lineIndex, right.line)}
            />
          ) : null
        }
      />
    </div>
  );
}

function SplitHalf({
  no,
  content,
  tone,
  action,
  border,
}: {
  no: number | null;
  content: string | null;
  tone: "ctx" | "add" | "del";
  action?: ReactNode;
  border?: boolean;
}) {
  const present = content != null;
  const bg = tone === "add" ? "rgba(46,158,98,0.11)" : tone === "del" ? "rgba(225,98,111,0.12)" : "transparent";
  const gut = tone === "add" ? "#2e9e62" : tone === "del" ? "#e0626f" : "transparent";
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-start overflow-hidden",
        border && "border-r border-black/5 dark:border-white/5",
      )}
      style={{
        background: bg,
        // Missing line on this side: diagonal hatch instead of a flat block so
        // it reads clearly as "no counterpart here".
        backgroundImage: present ? undefined : HATCH,
        borderLeft: `3px solid ${gut}`,
      }}
    >
      <span className={numCell}>{no ?? ""}</span>
      {present ? (
        <span className="min-w-0 flex-1 overflow-hidden">
          <Tokens content={content} />
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {action}
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
