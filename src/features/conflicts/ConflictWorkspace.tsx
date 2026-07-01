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
  endsWithNewline,
  hasMalformedHunk,
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

  // Git inverts ours/theirs during a rebase: HEAD ("ours", index stage 2) is the
  // commit you're replaying *onto*, and the patch being applied ("theirs", stage
  // 3) is your own commit. The "ours"/"theirs" buttons map straight to git's
  // `--ours`/`--theirs`, so the side *labels* must be operation-aware or a user
  // mid-rebase picks the opposite of what they intend.
  const rebasing = operation?.kind === "rebase";
  // A handoff carry (GL-74) re-applies the destination's own uncommitted changes
  // onto the handed-off branch: "ours" (stage 2) is that branch, "theirs" (stage
  // 3) is the destination's prior changes being replayed.
  const carrying = operation?.kind === "carry";
  const oursSub = rebasing
    ? "rebased onto (ours)"
    : headBranch
      ? `${headBranch} (ours)`
      : "current (ours)";
  const theirsSub = rebasing
    ? "your commit (theirs)"
    : carrying
      ? "carried changes (theirs)"
      : "incoming (theirs)";

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
  // Corrupt/truncated markers can't be reconstructed in-app — block staging and
  // tell the user to fix the file in their own editor.
  const malformed = hasMalformedHunk(regions);
  // A text file whose loaded content has no conflict markers left — edited away
  // externally, or emptied entirely — counts as resolved: `git add` it as-is.
  // Gate on loaded, non-binary content (not `regions.length`) so an empty file
  // (zero regions) still qualifies rather than getting stuck disabled.
  const textContentReady =
    !!selectedFile && selectedFile.kind === "text" && !!resolver.content && !resolver.content.binary;
  const noMarkers = textContentReady && totalHunks === 0;
  // Binary conflicts (and text classified binary) resolve as-is too — the user
  // picks a side, or stages their own external resolution via "Mark resolved".
  const selectedBinary =
    !!selectedFile &&
    (selectedFile.kind === "binary" || (selectedFile.kind === "text" && !!resolver.content?.binary));
  // Whole-file conflicts (binary, text-as-binary, or modify/delete) stage their
  // worktree copy as-is via `git add` when resolved manually/externally.
  const selectedWholeFile = selectedBinary || selectedFile?.kind === "deleted";
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

  // Stageable when any unstaged text file is fully decided locally. Memoized so
  // editor interactions (line toggles, mode switches) don't re-parse every
  // cached file on each render — only when the file set, decisions, picks, or
  // cached content actually change. (`contentFor` is stable per content cache.)
  // Declared before the early return below so it's never a conditional hook.
  const canStageAll = useMemo(
    () =>
      files.some((f) => {
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
      }),
    [files, resolver.contentFor, resolver.decisions, resolver.lineSel],
  );

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
    // No markers left (edited away / emptied) or a whole-file conflict (binary /
    // modify-delete) resolved externally: stage the worktree copy as-is.
    // Otherwise write the merged text rebuilt from the user's in-app hunk choices.
    if (noMarkers || selectedWholeFile) void markConflictResolved(target).then(done);
    else {
      const text = buildResolved(
        regions,
        fileDecisions,
        fileLineSel,
        endsWithNewline(resolver.content?.content ?? ""),
      );
      void resolveConflictFile(target, text).then(done);
    }
  };

  const stageAll = async () => {
    // Serialize: each resolveConflictFile shells out to `git add`, and concurrent
    // invocations contend for `.git/index.lock` (one fails, and the failure is
    // swallowed → that file silently isn't staged). Await each in turn.
    for (const f of files) {
      if (f.resolved) continue;
      const content = resolver.contentFor(f.path);
      if (!content || content.binary) continue;
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
      if (!ready) continue;
      const text = buildResolved(rgs, decs, sels, endsWithNewline(content.content));
      const ok = await resolveConflictFile(f.path, text);
      if (ok) resolver.resetFile(f.path);
    }
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-col gap-2.5 overflow-hidden" style={ACCENT_TINTS}>
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
          oursSub={oursSub}
          theirsSub={theirsSub}
          onSelect={resolver.select}
          onAcceptOurs={(p) => acceptSide(p, "ours")}
          onAcceptTheirs={(p) => acceptSide(p, "theirs")}
          onStageAll={() => void stageAll()}
        />

        {selectedFile ? (
          <ConflictEditor
            // Remount per file so the editor's scroll-to-first-conflict effect
            // re-runs when a different conflicted file is opened.
            key={selectedFile.path}
            file={selectedFile}
            regions={regions}
            // A file libgit2 classified "text" can still return binary content
            // (non-UTF-8, or a NUL in the worktree copy) — fall back to the
            // whole-file picker so the user isn't stranded in an empty editor.
            binaryContent={!!resolver.content?.binary}
            loading={resolver.contentLoading}
            mode={resolver.mode}
            onMode={resolver.setMode}
            decidedCount={decided}
            totalHunks={totalHunks}
            resolved={fileResolved}
            malformed={malformed}
            staged={fileStaged}
            decisionFor={decisionFor}
            lineSelFor={lineSelFor}
            oursSub={oursSub}
            theirsSub={theirsSub}
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
