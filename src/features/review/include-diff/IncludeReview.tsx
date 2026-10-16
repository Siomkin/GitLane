import { useEffect, useMemo, useRef, useState } from "react";
import type { Difference } from "@/lib/api";
import { fileWriteGuard } from "@/lib/advancedRepoState";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { matchesEvent, SHORTCUTS, ShortcutId } from "@/lib/shortcuts";
import { focusRing } from "@/lib/ui";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { EditIcon } from "@/components/ui/icons";
import { TriStateCheckbox } from "@/components/ui/TriStateCheckbox";
import { includeRows } from "@/features/changes/includeList";
import { BinaryDiff } from "@/features/review/BinaryDiff";
import { EmptyDiff } from "@/features/review/EmptyDiff";
import { ReviewHeader, type DiffMode } from "@/features/review/ReviewHeader";
import { SplitDiff, type DiffGutter } from "@/features/review/SplitDiff";
import { UnifiedDiff } from "@/features/review/UnifiedDiff";
import { workSurface } from "@/features/review/reviewSurface";
import { IncludeToolbar } from "./IncludeToolbar";
import {
  countsLabel,
  differenceCounts,
  differenceStartingAt,
  filePosition,
  neighbourFile,
  revertUnavailableReason,
  stepDifference,
  wholeFileReason,
} from "./includeDiffModel";
import { useFileDifferences } from "./useFileDifferences";

type Nav = {
  path: string;
  index: number | null;
  edge: "first" | "last" | null;
};

const DIFFERENCE_NAV = SHORTCUTS.find((s) => s.id === ShortcutId.DifferenceNav);
const FILE_NAV = SHORTCUTS.find((s) => s.id === ShortcutId.DiffFileNav);

/** Text fields and the terminal keep their own arrow keys. */
const ownsArrows = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest("input, textarea, select, [contenteditable], [data-terminal-host]") !== null;

/** The Include view of one working-tree file: its HEAD-to-working-tree diff with
 * a checkbox per difference (stage / unstage exactly those lines) and a revert
 * on excluded ones, plus difference and file navigation. */
export function IncludeReview({
  path,
  mode,
  onModeChange,
  wholeFile,
  onWholeFileChange,
  onBack,
}: {
  path: string;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  wholeFile: boolean;
  onWholeFileChange: (wholeFile: boolean) => void;
  onBack: () => void;
}) {
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const headOid = useRepo((s) => s.summary?.headOid ?? null);
  const changes = useRepo((s) => s.changes);
  const selectFile = useRepo((s) => s.selectFile);
  const applyLineRange = useRepo((s) => s.applyLineRange);
  const revertLineRange = useRepo((s) => s.revertLineRange);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const openRepoFile = useRepo((s) => s.openRepoFile);
  const beginFileEdit = useRepo((s) => s.beginFileEdit);
  const { data, error, loading } = useFileDifferences(repoPath, path, changes, wholeFile);
  const rows = useMemo(() => includeRows(changes), [changes]);
  const order = useMemo(() => rows.map((r) => r.path), [rows]);
  const [busy, setBusy] = useState(false);
  const [nav, setNav] = useState<Nav>({ path, index: null, edge: null });

  const differences = data?.differences ?? [];
  const current = nav.path === path ? nav : { path, index: null, edge: null };
  const index =
    current.edge && data
      ? differences.length === 0
        ? null
        : current.edge === "first"
          ? 0
          : differences.length - 1
      : current.index != null && current.index < differences.length
        ? current.index
        : null;
  const focused = index != null ? differences[index] : null;

  const run = (write: () => Promise<void>) => {
    setBusy(true);
    void write().finally(() => setBusy(false));
  };

  const openFile = (target: string, edge: Nav["edge"]) => {
    const source = rows.find((r) => r.path === target)?.source === "staged" ? "staged" : "unstaged";
    setNav({ path: target, index: null, edge });
    void selectFile(target, source);
  };
  const onFile = (step: 1 | -1) => {
    const target = neighbourFile(order, path, step);
    if (target) openFile(target, null);
  };
  const onDifference = (step: 1 | -1) => {
    const next = stepDifference(differences.length, index, step);
    if (next.kind === "here") {
      setNav({ path, index: next.index, edge: null });
      return;
    }
    const target = neighbourFile(order, path, step);
    if (target) openFile(target, next.edge);
  };

  // Latest navigation handlers for the window listener, refreshed after each
  // commit so the listener subscribes once (same idiom as FileEditor's save).
  const navRef = useRef({ onDifference, onFile });
  useEffect(() => {
    navRef.current = { onDifference, onFile };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || ownsArrows(e.target)) return;
      if (DIFFERENCE_NAV && matchesEvent(DIFFERENCE_NAV, e, isMac)) {
        e.preventDefault();
        navRef.current.onDifference(e.code === "ArrowUp" ? -1 : 1);
      } else if (FILE_NAV && matchesEvent(FILE_NAV, e, isMac)) {
        e.preventDefault();
        navRef.current.onFile(e.code === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (d: Difference) => {
    const unstage = d.inclusion === "included";
    const ranges = unstage ? d.unstage : d.stage;
    if (ranges.length > 0) run(() => applyLineRange(path, unstage, ranges));
  };
  const revert = (d: Difference) =>
    requestConfirm({
      title: "Revert this difference?",
      message: "The working-tree lines go back to the index version. This can't be undone.",
      confirmLabel: "Revert",
      danger: true,
      onConfirm: () => run(() => revertLineRange(path, d.stage)),
    });

  const gutter: DiffGutter = (hunkIndex, lineIndexes) => {
    const at = differenceStartingAt(differences, hunkIndex, lineIndexes);
    if (at < 0) return null;
    const d = differences[at];
    const checked = d.inclusion === "included" ? true : d.inclusion === "partial" ? "mixed" : false;
    const stuck = (checked === true ? d.unstage : d.stage).length === 0;
    const revertReason = revertUnavailableReason(d);
    return (
      <span className="flex items-center gap-1">
        <TriStateCheckbox
          checked={checked}
          label={checked === true ? "Exclude this difference" : "Include this difference"}
          onChange={() => toggle(d)}
          disabledReason={
            busy ? "Applying the last change" : stuck ? "Use the Staging area view for this change" : null
          }
        />
        <button
          type="button"
          aria-label="Revert this difference"
          title={revertReason ?? "Revert this difference"}
          disabled={busy || !!revertReason}
          onClick={() => revert(d)}
          className={cn(
            "rounded px-0.5 text-[13px] leading-none text-[color:var(--accent)] disabled:cursor-not-allowed disabled:text-neutral-300 dark:disabled:text-neutral-600",
            focusRing,
          )}
        >
          »
        </button>
      </span>
    );
  };

  const diff = data?.diff ?? null;
  const position = filePosition(order, path);
  const changeFile = [...changes.unstaged, ...changes.staged].find((f) => f.path === path);
  const editReason = !diff
    ? "Loading the diff"
    : diff.binary
      ? "Binary files can't be edited here"
      : diff.status === "D"
        ? "Deleted files can't be edited"
        : null;
  // The pencil opens the full-file editor (its save + unsaved-changes guards);
  // closing it returns here. A file the editor can't round-trip (mixed line
  // endings) opens read-only, with the reason on its Edit button.
  const edit = async () => {
    await openRepoFile(path);
    if (useRepo.getState().fileView?.path === path) beginFileEdit();
  };
  const reason = fileWriteGuard(changeFile, changes) ?? (diff ? wholeFileReason(diff, differences) : null);
  // Asked for the whole file but the backend fell back to hunks (too long).
  const tooLong = wholeFile && !!data && !data.wholeFile && diff?.status !== "U";
  const showingWhole = !!data?.wholeFile;
  const surface = workSurface("unstaged");
  const focus = focused ? { hunkIndex: focused.hunkIndex, lineIndex: focused.lineStart } : null;

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      <ReviewHeader
        file={diff}
        mode={mode}
        onModeChange={onModeChange}
        markdown={false}
        mdView="code"
        onMdViewChange={() => {}}
        onBack={onBack}
      />
      <IncludeToolbar
        position={position}
        counts={countsLabel(differenceCounts(differences))}
        onDifference={onDifference}
        onFile={onFile}
        canPrevFile={position.index > 0}
        canNextFile={position.index >= 0 && position.index < position.total - 1}
        extra={
          <>
            <button
              type="button"
              aria-label="Edit file"
              title={editReason ?? "Edit file"}
              disabled={!!editReason}
              onClick={() => void edit()}
              className={cn(
                "ml-1 grid h-7 w-7 place-items-center rounded-md text-neutral-500 hover:bg-black/5 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-neutral-100",
                focusRing,
              )}
            >
              <EditIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-pressed={wholeFile}
              onClick={() => onWholeFileChange(!wholeFile)}
              title="Show every line of the file"
              className={cn(
                "ml-1 h-7 rounded-md px-2 text-[12px]",
                wholeFile
                  ? "bg-[var(--accent-soft)] font-medium text-neutral-800 dark:text-neutral-100"
                  : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10",
                focusRing,
              )}
            >
              Whole file
            </button>
          </>
        }
      />
      {tooLong && (
        <div className="flex h-8 flex-none items-center border-b border-black/5 px-4 text-[12px] text-neutral-500 dark:border-white/5 dark:text-neutral-400">
          This file is too long to show whole, so only its changes are shown.
        </div>
      )}
      {reason && (
        <div className="flex h-8 flex-none items-center border-b border-black/5 px-4 text-[12px] text-neutral-500 dark:border-white/5 dark:text-neutral-400">
          {reason}
        </div>
      )}
      {loading ? (
        <EmptyDiff title="Loading diff" />
      ) : error ? (
        <EmptyDiff title={`Couldn't load this diff. ${error}`} />
      ) : !diff ? (
        <EmptyDiff title="Select a file to view its diff" />
      ) : diff.binary ? (
        <BinaryDiff diff={diff} className="min-h-0 flex-1 overflow-auto" />
      ) : diff.hunks.length === 0 ? (
        <EmptyDiff title="No difference from HEAD. Staged changes show in the Staging area view." />
      ) : mode === "split" ? (
        <SplitDiff
          file={diff}
          hunkAction={null}
          surface={surface}
          gutter={reason ? undefined : gutter}
          focus={focus}
          hideHunkHeaders={showingWhole}
          sideLabels={[headOid ? `HEAD · ${headOid.slice(0, 7)}` : "HEAD", "Working tree"]}
        />
      ) : (
        <UnifiedDiff
          file={diff}
          hunkAction={null}
          surface={surface}
          gutter={reason ? undefined : gutter}
          focus={focus}
          hideHunkHeaders={showingWhole}
        />
      )}
    </main>
  );
}
