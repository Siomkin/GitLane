import { useMemo } from "react";
import type { CSSProperties } from "react";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import {
  buildLineEditor,
  buildResolved,
  conflictRegionCount,
  decidedCount as decidedCountOf,
  deriveSelection,
  effectiveDecision,
  isResolved as isResolvedOf,
  parseConflict,
  type ConflictRegion,
  type LineSelection,
  type Region,
  type RegionDecision,
} from "./conflictModel";
import { AbortConfirm } from "./AbortConfirm";
import { ConflictBanner } from "./ConflictBanner";
import { ConflictEditor } from "./ConflictEditor";
import { ConflictFileList } from "./ConflictFileList";
import { useConflictResolver } from "./useConflictResolver";

// The conflict workspace defines the accent tints the design uses (the app only
// ships `--accent`); derived once here so every child can reference them.
const ACCENT_TINTS = {
  "--accent-soft": "color-mix(in srgb, var(--accent) 14%, transparent)",
  "--accent-body": "color-mix(in srgb, var(--accent) 10%, transparent)",
} as CSSProperties;

/** The first-class merge/rebase/cherry-pick/revert conflict-resolution view
 * (GL-36). Rendered by `App` whenever the repo store reports an active
 * `operation`; takes over the center pane so normal commit/stage flows are
 * gated while conflicts remain. */
export const ConflictWorkspace = () => {
  const operation = useRepo((s) => s.operation);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const headBranch = useRepo((s) => s.summary?.headBranch ?? null);
  const acceptConflictSide = useRepo((s) => s.acceptConflictSide);
  const resolveConflictFile = useRepo((s) => s.resolveConflictFile);
  const markConflictResolved = useRepo((s) => s.markConflictResolved);
  const reconflictFile = useRepo((s) => s.reconflictFile);
  const continueOperation = useRepo((s) => s.continueOperation);
  const abortOperation = useRepo((s) => s.abortOperation);
  const skipOperation = useRepo((s) => s.skipOperation);
  const showToast = useUi((s) => s.showToast);

  const resolver = useConflictResolver(operation, repoPath);

  const files = operation?.files ?? [];
  const total = files.length;
  const resolvedCount = files.filter((f) => f.resolved).length;
  const unresolved = total - resolvedCount;
  const allResolved = total === 0 || files.every((f) => f.resolved);

  const selectedFile = files.find((f) => f.path === resolver.selected) ?? null;

  // Parse the selected text file's conflicted content into hunks (the editor is
  // a painter over these). Non-text / unloaded files yield no regions.
  const regions = useMemo(() => {
    if (!selectedFile || selectedFile.kind !== "text" || !resolver.content) return [];
    if (resolver.content.binary) return [];
    return parseConflict(resolver.content.content);
  }, [selectedFile, resolver.content]);

  // Per-file decision lookups for the selected path.
  const path = resolver.selected ?? "";

  const fileDecisions = useMemo(() => {
    const out: Record<number, RegionDecision> = {};
    regions.forEach((_, idx) => {
      const d = resolver.decisions[`${path}::${idx}`];
      if (d) out[idx] = d;
    });
    return out;
  }, [regions, resolver.decisions, path]);

  const fileLineSel = useMemo(() => {
    const out: Record<number, LineSelection> = {};
    regions.forEach((_, idx) => {
      const s = resolver.lineSel[`${path}::${idx}`];
      if (s) out[idx] = s;
    });
    return out;
  }, [regions, resolver.lineSel, path]);

  // The effective per-hunk decision reconciles whole-hunk + line-level choices.
  const decisionFor = (idx: number): RegionDecision | undefined =>
    effectiveDecision(fileDecisions[idx], fileLineSel[idx]);
  const lineSelFor = (idx: number): LineSelection => fileLineSel[idx] ?? new Set<string>();
  // For the line editor: explicit picks, else the picks implied by a whole-hunk
  // decision (so switching modes carries the choice over).
  const selectionFor = (idx: number): LineSelection => {
    const explicit = fileLineSel[idx];
    if (explicit) return explicit;
    const region = regions[idx];
    return region && region.kind === "cf"
      ? deriveSelection(region, fileDecisions[idx])
      : new Set<string>();
  };

  const lineEditor = useMemo(
    () => buildLineEditor(regions, selectionFor),
    // selectionFor closes over fileDecisions/fileLineSel, which drive the picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regions, fileDecisions, fileLineSel],
  );

  const totalHunks = conflictRegionCount(regions);
  const decided = decidedCountOf(regions, fileDecisions, fileLineSel);
  // A text file with no markers left (edited away) counts as resolved too.
  const noMarkers = !!selectedFile && selectedFile.kind === "text" && regions.length > 0 && totalHunks === 0;
  const fileStaged = !!selectedFile?.resolved;
  const fileResolved =
    fileStaged || noMarkers || (totalHunks > 0 && isResolvedOf(regions, fileDecisions, fileLineSel));

  // Line-editor mutations: compute the next selection from the current effective
  // one and hand it to the hook (which stores it and clears any whole-hunk dec).
  const sideKeys = (region: ConflictRegion, side: "a" | "b") =>
    (side === "a" ? region.ours : region.theirs).map((_, i) => `${side}:${i}`);

  const onToggleLine = (idx: number, side: "a" | "b", lineIdx: number) => {
    const next = new Set(selectionFor(idx));
    const key = `${side}:${lineIdx}`;
    if (next.has(key)) next.delete(key);
    else next.add(key);
    resolver.setLineSelection(path, idx, next);
  };
  const onSetBlock = (idx: number, side: "a" | "b", on: boolean) => {
    const region = regions[idx];
    if (!region || region.kind !== "cf") return;
    const next = new Set(selectionFor(idx));
    sideKeys(region, side).forEach((k) => (on ? next.add(k) : next.delete(k)));
    resolver.setLineSelection(path, idx, next);
  };
  const onTakeBlock = (idx: number, which: "a" | "b" | "both") => {
    const region = regions[idx];
    if (!region || region.kind !== "cf") return;
    const next = new Set<string>();
    if (which === "a" || which === "both") sideKeys(region, "a").forEach((k) => next.add(k));
    if (which === "b" || which === "both") sideKeys(region, "b").forEach((k) => next.add(k));
    resolver.setLineSelection(path, idx, next);
  };
  const onSelectAllSide = (side: "a" | "b", on: boolean) => {
    regions.forEach((region: Region, idx) => {
      if (region.kind !== "cf") return;
      const next = new Set(selectionFor(idx));
      sideKeys(region, side).forEach((k) => (on ? next.add(k) : next.delete(k)));
      resolver.setLineSelection(path, idx, next);
    });
  };

  if (!operation) return null;

  const op = (fn: () => Promise<string>) => {
    void fn()
      .then((msg) => showToast(msg))
      .catch((e) => showToast(String(e instanceof Error ? e.message : e), "error"));
  };

  // Only drop local decisions once the git write actually succeeded — a failed
  // resolve/stage leaves the file conflicted, so the user's choices must survive.
  const acceptSide = (target: string, side: "ours" | "theirs") => {
    void acceptConflictSide(target, side).then((ok) => {
      if (ok) resolver.resetFile(target);
    });
  };

  const markResolved = () => {
    if (!selectedFile) return;
    const target = selectedFile.path;
    const done = (ok: boolean) => {
      if (ok) resolver.resetFile(target);
    };
    if (noMarkers) void markConflictResolved(target).then(done);
    else void resolveConflictFile(target, buildResolved(regions, fileDecisions, fileLineSel)).then(done);
  };

  const stageAll = () => {
    files.forEach((f) => {
      if (f.resolved) return;
      const content = resolver.contentFor(f.path);
      if (!content || content.binary) return;
      const rgs = parseConflict(content.content);
      const decs: Record<number, RegionDecision> = {};
      const sels: Record<number, LineSelection> = {};
      rgs.forEach((_, idx) => {
        const d = resolver.decisions[`${f.path}::${idx}`];
        if (d) decs[idx] = d;
        const s = resolver.lineSel[`${f.path}::${idx}`];
        if (s) sels[idx] = s;
      });
      const ready = conflictRegionCount(rgs) === 0 || isResolvedOf(rgs, decs, sels);
      if (!ready) return;
      void resolveConflictFile(f.path, buildResolved(rgs, decs, sels)).then((ok) => {
        if (ok) resolver.resetFile(f.path);
      });
    });
  };

  // Stageable when any unstaged text file is fully decided locally.
  const canStageAll = files.some((f) => {
    if (f.resolved) return false;
    const content = resolver.contentFor(f.path);
    if (!content || content.binary) return false;
    const rgs = parseConflict(content.content);
    const decs: Record<number, RegionDecision> = {};
    const sels: Record<number, LineSelection> = {};
    rgs.forEach((_, idx) => {
      const d = resolver.decisions[`${f.path}::${idx}`];
      if (d) decs[idx] = d;
      const s = resolver.lineSel[`${f.path}::${idx}`];
      if (s) sels[idx] = s;
    });
    return conflictRegionCount(rgs) === 0 || isResolvedOf(rgs, decs, sels);
  });

  return (
    <div className="relative flex h-full flex-col gap-2.5" style={ACCENT_TINTS}>
      <ConflictBanner
        kind={operation.kind}
        canSkip={operation.canSkip}
        total={total}
        unresolved={unresolved}
        allResolved={allResolved}
        onContinue={() => op(continueOperation)}
        onAbort={() => resolver.setConfirmAbort(true)}
        onSkip={() => op(skipOperation)}
      />

      <div className="flex min-h-0 flex-1 flex-row-reverse gap-2.5">
        <ConflictFileList
          files={files}
          selected={resolver.selected}
          total={total}
          resolved={resolvedCount}
          unresolved={unresolved}
          canStageAll={canStageAll}
          onSelect={resolver.select}
          onAcceptOurs={(p) => acceptSide(p, "ours")}
          onAcceptTheirs={(p) => acceptSide(p, "theirs")}
          onStageAll={stageAll}
        />

        {selectedFile ? (
          <ConflictEditor
            file={selectedFile}
            regions={regions}
            loading={resolver.contentLoading}
            mode={resolver.mode}
            onMode={resolver.setMode}
            decidedCount={decided}
            totalHunks={totalHunks}
            resolved={fileResolved}
            staged={fileStaged}
            decisionFor={decisionFor}
            lineSelFor={lineSelFor}
            oursSub={headBranch ? `${headBranch} (ours)` : "current (ours)"}
            theirsSub="incoming (theirs)"
            lineEditor={lineEditor}
            onDecide={(idx, dec) => resolver.decide(path, idx, dec)}
            onUndo={(idx) => resolver.undo(path, idx)}
            onToggleLine={onToggleLine}
            onSetBlock={onSetBlock}
            onTakeBlock={onTakeBlock}
            onSelectAllSide={onSelectAllSide}
            onMarkResolved={markResolved}
            onUnstage={() => {
              const target = selectedFile.path;
              void reconflictFile(target).then((ok) => {
                if (ok) resolver.resetFile(target);
              });
            }}
            onAcceptSide={(side) => acceptSide(selectedFile.path, side)}
          />
        ) : (
          <section className="grid flex-1 place-content-center rounded-xl border border-black/5 bg-white text-[13px] text-neutral-400 dark:border-white/5 dark:bg-neutral-800">
            No conflicts left to resolve — continue the {operation.kind}.
          </section>
        )}
      </div>

      {resolver.confirmAbort && (
        <AbortConfirm
          kind={operation.kind}
          onCancel={() => resolver.setConfirmAbort(false)}
          onConfirm={() => {
            resolver.setConfirmAbort(false);
            op(abortOperation);
          }}
        />
      )}
    </div>
  );
};
