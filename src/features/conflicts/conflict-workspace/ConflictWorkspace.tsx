import type { CSSProperties } from "react";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { AbortConfirm } from "@/features/conflicts/AbortConfirm";
import { ConflictBanner } from "@/features/conflicts/ConflictBanner";
import { ConflictEditor } from "@/features/conflicts/ConflictEditor";
import { ConflictFileList } from "@/features/conflicts/ConflictFileList";
import { useConflictResolver } from "@/features/conflicts/useConflictResolver";
import { AiConflictResolve, aiRunState, landProposal, useAiResolveRuns } from "@/features/conflicts/ai-resolve";
import { stagePlanFor } from "./conflictWorkspaceModel";
import { useConflictWorkspaceModel } from "./useConflictWorkspaceModel";

// The conflict workspace defines the accent tints the design uses (the app only
// ships `--accent`); derived once here so every child can reference them.
const ACCENT_TINTS = {
  "--accent-soft": "color-mix(in srgb, var(--accent) 14%, transparent)",
  "--accent-body": "color-mix(in srgb, var(--accent) 10%, transparent)",
} as CSSProperties;

/** The first-class merge/rebase/cherry-pick/revert conflict-resolution view
 * (GL-36). Rendered by `App` whenever the repo store reports an active
 * `operation`; takes over the center pane so normal commit/stage flows are
 * gated while conflicts remain. The container owns store/API wiring and the
 * durable-write commands; every rendering input comes from the view model
 * (`useConflictWorkspaceModel` over the pure `conflictWorkspaceModel`), and
 * the transient editing state lives in `useConflictResolver` (GL-179). */
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
  const model = useConflictWorkspaceModel(operation, headBranch, resolver);
  const { selectedFile, state } = model;
  // Agent runs live here, above the selection, so a run started on one file
  // survives switching to another (and "Resolve all" can queue them). Every
  // answer lands in Output — aligned hunks as ticks/custom text, unalignable
  // rewrites as a whole-file Output editor.
  const aiRuns = useAiResolveRuns({
    repoPath,
    readContent: resolver.revalidate,
    applyToEditor: (target, proposal, source) => landProposal(resolver, target, proposal, source),
    // "Resolve again" must not keep the previous landing under the new spinner.
    onReset: resolver.resetFile,
  });
  const aiTargets = model.files.filter((f) => !f.resolved && f.kind === "text").map((f) => f.path);

  if (!operation) return null;

  // A file's local decisions and the agent run that produced them retire
  // together: once it is staged, unstaged, or discarded, a lingering "ready to
  // apply" row would point at a proposal that is no longer in the editor.
  const clearFile = (target: string) => {
    resolver.resetFile(target);
    aiRuns.clear(target);
  };

  const op = (fn: () => Promise<string>) => {
    void fn().catch((e) =>
      showToast(String(e instanceof Error ? e.message : e), "error"),
    );
  };

  // Only drop local decisions once the git write actually succeeded — a failed
  // resolve/stage leaves the file conflicted, so the user's choices must survive.
  const acceptSide = (target: string, side: "ours" | "theirs") => {
    void acceptConflictSide(target, side).then((ok) => {
      if (ok) clearFile(target);
    });
  };

  // Stage one text file against its freshly-read disk copy (GL-180): re-fetch
  // right before writing, re-read the live operation entry, and let the plan
  // decide — write the validated merge, stage a marker-free worktree copy
  // as-is (the same path per-file "Mark resolved" takes, so the two flows never
  // diverge), or skip because the file changed under the decisions.
  const stagePlanned = async (
    target: string,
  ): Promise<"staged" | "failed" | "skipped" | "reclassified" | "changed"> => {
    const before = useRepo.getState().operation?.files.find((f) => f.path === target);
    if (!before || before.resolved) return "skipped";
    const fresh = await resolver.revalidate(target);
    if (!fresh) {
      showToast(`Couldn't re-read ${target} before staging`, "error");
      return "skipped";
    }
    // Re-read the live entry AFTER the await — the watcher can reclassify or
    // resolve the file while the disk read was in flight (GL-180 review); the
    // pre-await read only short-circuits the fetch for already-settled files.
    const current = useRepo.getState().operation?.files.find((f) => f.path === target);
    if (!current || current.resolved) return "skipped";
    // A reclassification (text → binary/deleted, or text-classified content
    // that reads back binary) isn't hunk staleness — report it as what it is
    // so the caller's toast doesn't mislead (GL-180 review).
    if (current.kind !== "text" || fresh.binary) return "reclassified";
    // The resolver satisfies `Resolutions` structurally — the per-cell choice
    // map and the whole-file axis are only ever read together.
    const plan = stagePlanFor(current, fresh, resolver);
    if (plan.action === "skip") return "changed";
    const ok =
      plan.action === "stageAsIs"
        ? await markConflictResolved(target)
        : await resolveConflictFile(target, plan.text);
    if (ok) clearFile(target);
    // A failed write already toasts through the store action — report it
    // distinctly so callers don't mislabel it "changed on disk".
    return ok ? "staged" : "failed";
  };

  // Toasts matched to the two non-write outcomes: stale hunks vs. a file that
  // is no longer a text conflict at all.
  const notStaged = (target: string, outcome: Awaited<ReturnType<typeof stagePlanned>>) => {
    if (outcome === "changed")
      showToast(`${target} changed on disk — review the updated conflicts`, "error");
    else if (outcome === "reclassified")
      showToast(`${target} is no longer a text conflict — resolve it as a whole file`, "error");
  };

  const markResolved = () => {
    if (!selectedFile) return;
    const target = selectedFile.path;
    // A whole-file conflict (binary, text-as-binary, or modify/delete) resolved
    // externally stages the worktree copy as-is — no cached text is involved,
    // so there is nothing to go stale.
    if (state.wholeFile) {
      void markConflictResolved(target).then((ok) => {
        if (ok) clearFile(target);
      });
      return;
    }
    void stagePlanned(target).then((outcome) => notStaged(target, outcome));
  };

  const stageAll = async () => {
    // Serialize: each staging write shells out to `git add`, and concurrent
    // invocations contend for `.git/index.lock` (one fails, and the failure is
    // swallowed → that file silently isn't staged). Await each in turn. The
    // render snapshot only pre-filters; each write re-checks the live state.
    for (const f of model.files) {
      if (f.resolved || model.resolvedTextFor(f) == null) continue;
      notStaged(f.path, await stagePlanned(f.path));
    }
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-col gap-2.5 overflow-hidden" style={ACCENT_TINTS}>
      <ConflictBanner
        kind={operation.kind}
        canSkip={operation.canSkip}
        total={model.total}
        unresolved={model.unresolved}
        allResolved={model.allResolved}
        onContinue={() => op(continueOperation)}
        onAbort={() => resolver.setConfirmAbort(true)}
        onSkip={() => op(skipOperation)}
      />

      {/* Text conflicts only: the agent answers with a file body, which is
          meaningless for a binary or modify/delete conflict, pointless for a
          worktree copy that already has no markers left, and wrong on a file
          that is already staged (the conflicted snapshot can linger in cache
          for one frame while the staged result loads). */}
      {selectedFile && !state.wholeFile && !state.staged && !state.noMarkers && (
        <AiConflictResolve
          path={selectedFile.path}
          allPaths={aiTargets}
          runs={aiRuns}
          // The proposal was landed across the whole file, and nothing snapshots
          // what was there before it — so discarding resets the file's decisions.
          onDiscardProposal={clearFile}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-row-reverse gap-2.5">
        <ConflictFileList
          files={model.files}
          selected={resolver.selected}
          aiStateFor={(path) => aiRunState(aiRuns.runs[path])}
          total={model.total}
          resolved={model.resolvedCount}
          unresolved={model.unresolved}
          canStageAll={model.canStageAll}
          oursSub={model.oursSub}
          theirsSub={model.theirsSub}
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
            regions={model.regions}
            // A file libgit2 classified "text" can still return binary content
            // (non-UTF-8, or a NUL in the worktree copy) — fall back to the
            // whole-file picker so the user isn't stranded in an empty editor.
            binaryContent={!!resolver.content?.binary}
            content={resolver.content && !resolver.content.binary ? resolver.content.content : null}
            loading={resolver.contentLoading}
            mode={resolver.mode}
            onMode={resolver.setMode}
            decidedCount={state.decided}
            totalHunks={state.totalHunks}
            resolved={state.resolved}
            malformed={state.malformed}
            staged={state.staged}
            choiceFor={model.choiceFor}
            oursSub={model.oursSub}
            theirsSub={model.theirsSub}
            lineEditor={model.lineEditor}
            onDecide={(idx, dec) => resolver.decide(model.path, idx, dec)}
            onUndo={(idx) => resolver.undo(model.path, idx)}
            onToggleLine={model.onToggleLine}
            onSetBlock={model.onSetBlock}
            onTakeBlock={model.onTakeBlock}
            onSelectAllSide={model.onSelectAllSide}
            onEditOutput={model.onEditOutput}
            fileEdit={
              model.fileEdit
                ? { ...model.fileEdit, onUndo: () => clearFile(selectedFile.path) }
                : null
            }
            onMarkResolved={markResolved}
            onUnstage={() => {
              const target = selectedFile.path;
              void reconflictFile(target).then((ok) => {
                if (ok) clearFile(target);
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
