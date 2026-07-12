import { FileIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { basename, dirname } from "@/lib/paths";
import type { OperationFile } from "@/store/repo";
import type { LineEditor, LineSelection, Region, RegionDecision } from "./conflictModel";
import { InlineConflict } from "./InlineConflict";
import { SplitConflict } from "./SplitConflict";
import type { EditorMode } from "./useConflictResolver";

/** Segmented-toggle button classes (Inline / Split) — state-free. */
const seg = (active: boolean) =>
  cn(
    "h-6 rounded-md px-2.5",
    active
      ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );

const CheckIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={className}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const WarnDot = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <path d="M12 8v5M12 16h.01" />
    <circle cx="12" cy="12" r="9" />
  </svg>
);

const WholeFileCard = ({
  title,
  detail,
  primaryLabel,
  primaryTone,
  secondaryLabel,
  secondaryTone,
  onPrimary,
  onSecondary,
}: {
  title: string;
  detail: string;
  primaryLabel: string;
  primaryTone: "accent" | "blue";
  /** Omitted when there's only one sensible resolution (both-deleted). */
  secondaryLabel?: string;
  secondaryTone?: "rose" | "blue";
  onPrimary: () => void;
  onSecondary?: () => void;
}) => (
  <div className="mx-auto max-w-[640px] px-6 py-10">
    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-400/20 dark:bg-amber-400/10">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="mt-0.5 h-5 w-5 shrink-0 text-amber-500">
        <path d="M10.3 3.2 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      <div>
        <div className="text-[13.5px] font-semibold text-neutral-800 dark:text-neutral-100">{title}</div>
        <div className="mt-0.5 text-[12.5px] text-neutral-500 dark:text-neutral-400">{detail}</div>
      </div>
    </div>
    <div className={cn("mt-4 grid gap-3", secondaryLabel ? "grid-cols-2" : "grid-cols-1")}>
      <button type="button"
        onClick={onPrimary}
        className={cn(
          "rounded-xl border p-3.5 text-left transition-colors",
          primaryTone === "accent"
            ? "border-black/10 hover:border-[color:var(--accent)]/50 dark:border-white/10"
            : "border-black/10 hover:border-[#3b7ff5]/50 dark:border-white/10",
        )}
      >
        <span
          className={cn(
            "text-[13px] font-semibold",
            primaryTone === "accent" ? "text-[color:var(--accent)]" : "text-[#3b7ff5]",
          )}
        >
          {primaryLabel}
        </span>
      </button>
      {secondaryLabel && (
        <button type="button"
          onClick={onSecondary}
          className={cn(
            "rounded-xl border p-3.5 text-left transition-colors",
            secondaryTone === "rose"
              ? "border-black/10 hover:border-rose-400/50 dark:border-white/10"
              : "border-black/10 hover:border-[#3b7ff5]/50 dark:border-white/10",
          )}
        >
          <span
            className={cn(
              "text-[13px] font-semibold",
              secondaryTone === "rose" ? "text-rose-500" : "text-[#3b7ff5]",
            )}
          >
            {secondaryLabel}
          </span>
        </button>
      )}
    </div>
  </div>
);

export const ConflictEditor = ({
  file,
  regions,
  binaryContent,
  loading,
  mode,
  onMode,
  decidedCount,
  totalHunks,
  resolved,
  malformed,
  staged,
  decisionFor,
  lineSelFor,
  oursSub,
  theirsSub,
  lineEditor,
  onDecide,
  onUndo,
  onToggleLine,
  onSetBlock,
  onTakeBlock,
  onSelectAllSide,
  onMarkResolved,
  onUnstage,
  onAcceptSide,
}: {
  file: OperationFile;
  regions: Region[];
  /** The fetched content came back binary (non-UTF-8 / NUL) even though the file
   * was classified "text" — render the whole-file picker instead of the editor. */
  binaryContent: boolean;
  loading: boolean;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  decidedCount: number;
  totalHunks: number;
  resolved: boolean;
  /** The file has structurally broken conflict markers — in-app resolution is
   * disabled and the user is told to fix it in their own editor. */
  malformed: boolean;
  staged: boolean;
  decisionFor: (idx: number) => RegionDecision | undefined;
  lineSelFor: (idx: number) => LineSelection;
  oursSub: string;
  theirsSub: string;
  /** Prebuilt side-by-side line editor view-model (only used in split mode). */
  lineEditor: LineEditor;
  onDecide: (idx: number, decision: RegionDecision) => void;
  onUndo: (idx: number) => void;
  onToggleLine: (regionIdx: number, side: "a" | "b", lineIdx: number) => void;
  onSetBlock: (regionIdx: number, side: "a" | "b", on: boolean) => void;
  onTakeBlock: (regionIdx: number, which: "a" | "b" | "both") => void;
  onSelectAllSide: (side: "a" | "b", on: boolean) => void;
  onMarkResolved: () => void;
  onUnstage: () => void;
  onAcceptSide: (side: "ours" | "theirs") => void;
}) => {
  // A "text" file whose content loaded as binary is handled like a binary file:
  // the whole-file picker, not the (empty) line editor. `editableText` gates the
  // line-editor chrome (mode toggle + resolve footer).
  const showWholeFile = file.kind === "binary" || (file.kind === "text" && binaryContent);
  // Whole-file conflicts (binary, text-as-binary, or modify/delete) share one
  // footer: stage a manual external resolution (`git add`) when unstaged, or
  // re-conflict (unstage) when already staged.
  const wholeFile = file.kind === "deleted" || showWholeFile;
  const editableText = file.kind === "text" && !binaryContent;
  const statusLabel = staged ? "Resolved" : resolved ? "Ready to stage" : "Conflicted";
  const statusClass = staged
    ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
    : resolved
      ? "bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"
      : "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300";

  const footLabel = malformed
    ? "Conflict markers look malformed — fix this file in your editor, then stage it"
    : staged
      ? "Resolved and staged"
      : resolved
        ? "All conflicts resolved — stage to finish this file"
        : `${decidedCount} of ${totalHunks} conflict${totalHunks === 1 ? "" : "s"} resolved`;

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-black/5 px-4 dark:border-white/5">
        <span className="text-[color:var(--accent)]">
          <FileIcon path={file.path} size={18} />
        </span>
        <span className="text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">
          {basename(file.path)}
        </span>
        <span className="truncate text-[12px] text-neutral-400">{dirname(file.path)}</span>
        <span className={cn("grid h-5 place-items-center rounded px-1.5 text-[10px] font-semibold", statusClass)}>
          {statusLabel}
        </span>
        {editableText && !staged && (
          <div className="ml-auto flex rounded-lg bg-black/[0.06] p-0.5 text-[12px] dark:bg-white/[0.06]">
            <button type="button" onClick={() => onMode("split")} className={seg(mode === "split")}>
              Side by side
            </button>
            <button type="button" onClick={() => onMode("inline")} className={seg(mode === "inline")}>
              Inline
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {staged ? (
          <div className="grid flex-1 place-content-center px-6 text-center text-[13px] text-neutral-400">
            This file is resolved and staged. Unstage it below to make further edits.
          </div>
        ) : file.kind === "deleted" ? (
          file.deletedSide === "both" ? (
            // DD conflict (e.g. rename/rename): neither side kept a version,
            // so the only resolution is confirming the deletion.
            <WholeFileCard
              title={`Deleted on both ${oursSub} and ${theirsSub}`}
              detail={`Both sides removed ${file.path} — there is no version to keep. Confirm the deletion to resolve it.`}
              primaryLabel="Accept deletion"
              primaryTone="accent"
              onPrimary={() => onAcceptSide("ours")}
            />
          ) : (
            <WholeFileCard
              title={
                file.deletedSide === "ours"
                  ? `Deleted on ${oursSub}, modified on ${theirsSub}`
                  : `Modified on ${oursSub}, deleted on ${theirsSub}`
              }
              detail={`${file.path} cannot be auto-merged. Keep a version, or accept the deletion.`}
              primaryLabel={file.deletedSide === "ours" ? "Accept deletion" : `Keep ${oursSub}`}
              primaryTone="accent"
              secondaryLabel={file.deletedSide === "ours" ? `Keep ${theirsSub}` : "Accept deletion"}
              secondaryTone={file.deletedSide === "ours" ? "blue" : "rose"}
              onPrimary={() => onAcceptSide("ours")}
              onSecondary={() => onAcceptSide("theirs")}
            />
          )
        ) : showWholeFile ? (
          <WholeFileCard
            title="Binary file — no line-level merge"
            detail={`Both sides changed ${basename(file.path)}. Choose which version to keep.`}
            primaryLabel={`Keep ${oursSub}`}
            primaryTone="accent"
            secondaryLabel={`Take ${theirsSub}`}
            secondaryTone="blue"
            onPrimary={() => onAcceptSide("ours")}
            onSecondary={() => onAcceptSide("theirs")}
          />
        ) : loading ? (
          <div className="px-4 py-3 text-xs text-neutral-400">Loading conflict…</div>
        ) : mode === "split" ? (
          <SplitConflict
            editor={lineEditor}
            oursSub={oursSub}
            theirsSub={theirsSub}
            onToggleLine={onToggleLine}
            onSetBlock={onSetBlock}
            onTakeBlock={onTakeBlock}
            onSelectAll={onSelectAllSide}
          />
        ) : (
          <InlineConflict
            regions={regions}
            oursSub={oursSub}
            theirsSub={theirsSub}
            decisionFor={decisionFor}
            lineSelFor={lineSelFor}
            onDecide={onDecide}
            onUndo={onUndo}
          />
        )}

        {wholeFile && (
          // Whole-file conflicts can't be merged line by line, but a user who
          // resolved the file in an external tool (custom binary merge, a kept
          // modify/delete version, or its deletion) still needs to stage that
          // worktree copy — `git add -A` via onMarkResolved — or undo a wrong
          // side pick with Unstage once it's staged.
          <div className="flex shrink-0 items-center gap-3 border-t border-black/5 bg-white px-4 py-2.5 dark:border-white/5 dark:bg-neutral-800">
            <span className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
              {staged ? "Resolved and staged" : "Resolved this file in another tool?"}
            </span>
            <button type="button"
              onClick={staged ? onUnstage : onMarkResolved}
              className="ml-auto h-9 rounded-lg border border-black/10 px-3.5 text-[13px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
            >
              {staged ? "Unstage" : "Stage current version"}
            </button>
          </div>
        )}

        {editableText && (
          <div className="flex shrink-0 items-center gap-3 border-t border-black/5 bg-white px-4 py-2.5 dark:border-white/5 dark:bg-neutral-800">
            <span
              className={cn(
                "grid h-5 w-5 shrink-0 place-items-center rounded-full",
                resolved
                  ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                  : "bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300",
              )}
            >
              {resolved ? <CheckIcon className="h-3.5 w-3.5" /> : <WarnDot className="h-3.5 w-3.5" />}
            </span>
            <span className="text-[12.5px] text-neutral-600 dark:text-neutral-300">{footLabel}</span>
            <div className="ml-auto flex items-center gap-2">
              {staged && (
                <button type="button"
                  onClick={onUnstage}
                  className="h-9 rounded-lg border border-black/10 px-3.5 text-[13px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
                >
                  Unstage
                </button>
              )}
              <button type="button"
                onClick={onMarkResolved}
                disabled={!resolved || staged}
                className={cn(
                  "h-9 rounded-lg px-3.5 text-[13px] font-medium",
                  !resolved || staged
                    ? "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10"
                    : "bg-[var(--accent)] text-white hover:brightness-110",
                )}
              >
                {staged ? "Staged" : "Mark resolved & stage"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
