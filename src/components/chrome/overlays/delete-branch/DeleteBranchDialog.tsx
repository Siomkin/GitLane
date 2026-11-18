// The delete-branch modal: preview and confirm (with an opt-in "also delete on
// the remote"), then a live step checklist, then the outcome. Closing it mid-run
// is safe — the delete keeps going and a failure lands as a toast. Shell and
// checklist follow DeleteWorktreeDialog (GL-107).

import { useEffect, useRef, useState } from "react";
import {
  DIALOG_LAYER,
  DialogCloseRow,
  LARGE_DANGER_BUTTON,
  LARGE_SECONDARY_BUTTON,
  ModalFrame,
} from "@/components/chrome/overlays/dialogs/frame";
import { ImpactPanel } from "@/components/chrome/overlays/dialogs/ConfirmDialog";
import { OutcomeBadge, StepList, stepStatus, useCloseWhenDone } from "@/components/chrome/overlays/progress";
import { BranchKind, type DeleteBranchPreview, type DestructivePreview } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { TrashIcon, WarningIcon } from "@/components/ui/icons";
import { InlineSpinner } from "@/components/ui/Loading";
import { useRepo } from "@/store/repo";
import { useUi, type DeleteBranchRequest } from "@/store/ui";
import { useDeleteBranchRun } from "./useDeleteBranchRun";

export { DONE_CLOSE_MS } from "@/components/chrome/overlays/progress";

export function DeleteBranchDialog() {
  const req = useUi((s) => s.deleteBranch);
  if (!req) return null;
  // Keyed so reopening (or another branch) always starts a fresh flow.
  return <DeleteBranchDialogBody key={`${req.repoPath}#${req.branch}`} req={req} />;
}

type PreviewState =
  | { kind: "loading" }
  // `remote` is null when there is no counterpart, its preview failed, or its
  // tracking ref is gone: only the checkbox is withheld then. `oid` is the
  // tracking tip read with the preview — the lease the push is pinned to.
  | {
      kind: "ready";
      local: DeleteBranchPreview;
      remote: { preview: DestructivePreview; oid: string } | null;
    }
  | { kind: "error"; error: string };

function DeleteBranchDialogBody({ req }: { req: DeleteBranchRequest }) {
  const close = useUi((s) => s.closeDeleteBranch);
  const running = useUi((s) => s.deleteBranchRunning);
  const { phase, rows, reached, failedAt, message, start } = useDeleteBranchRun(req);
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [withRemote, setWithRemote] = useState(false);

  const previewDeleteBranch = useRepo((s) => s.previewDeleteBranch);
  const previewDeleteRemoteBranch = useRepo((s) => s.previewDeleteRemoteBranch);

  // Through the store, which previews the active repo; a repo switch closes
  // this dialog (repo-switch reset), so that is always `req.repoPath`.
  useEffect(() => {
    let alive = true;
    const target = req.alsoRemote;
    Promise.all([
      previewDeleteBranch(req.branch),
      target ? previewDeleteRemoteBranch(target.remote, target.branch).catch(() => null) : null,
    ])
      .then(([local, remotePreview]) => {
        if (!alive) return;
        // Lease from the branch list as of this preview, not the menu-open
        // snapshot: a fetch in between would otherwise fail the push.
        const oid = target
          ? useRepo
              .getState()
              .branches.find((b) => b.kind === BranchKind.Remote && b.name === `${target.remote}/${target.branch}`)
              ?.target
          : null;
        setPreview({ kind: "ready", local, remote: remotePreview && oid ? { preview: remotePreview, oid } : null });
      })
      .catch((e) => alive && setPreview({ kind: "error", error: String(e) }));
    return () => {
      alive = false;
    };
  }, [req, previewDeleteBranch, previewDeleteRemoteBranch]);

  // Success needs no reading: show the ticked list briefly, then get out of the way.
  const closeRef = useCloseWhenDone(phase === "done", close);

  // Focus Delete once it can act; it mounts disabled while the preview loads.
  const deleteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (preview.kind === "ready") deleteRef.current?.focus();
  }, [preview.kind]);

  const remote = preview.kind === "ready" ? preview.remote : null;
  const offerRemote = req.alsoRemote !== null && remote !== null;
  const both = offerRemote && withRemote;
  const remoteRef = req.alsoRemote ? `${req.alsoRemote.remote}/${req.alsoRemote.branch}` : "";

  const badge = (
    <OutcomeBadge
      tone={phase === "done" ? "success" : phase === "error" ? "failure" : phase === "configure" ? "danger" : "neutral"}
      icon={<TrashIcon className="h-5 w-5" />}
    />
  );
  const title =
    phase === "configure"
      ? `Delete branch ${req.branch}?`
      : phase === "running"
        ? `Deleting ${req.branch}`
        : phase === "done"
          ? message
          : rows.length === 3 && failedAt === 0
            ? "Nothing was deleted"
            : rows.length === 3
              ? `Couldn’t finish deleting ${req.branch}`
              : `Couldn’t delete ${req.branch}`;

  return (
    <ModalFrame
      z={DIALOG_LAYER.Top}
      label={title}
      // Mid-run a stray backdrop click shouldn't drop the progress view.
      backdropDismiss={phase !== "running"}
      panelClassName="w-[440px]"
      onDismiss={close}
    >
      <DialogCloseRow closeRef={closeRef} onClose={close} badge={badge} />
      <div className="mt-3 text-[15px] font-semibold text-neutral-800 [overflow-wrap:anywhere] dark:text-neutral-100">
        {title}
      </div>

      {phase === "configure" && (
        <>
          <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
            The branch ref will be removed. Unmerged commits may be lost.
          </div>
          {preview.kind === "loading" && (
            <div className="mt-3.5 flex items-center gap-2.5 text-[12.5px] text-neutral-400">
              <InlineSpinner className="h-4 w-4" />
              Checking what deleting this loses…
            </div>
          )}
          {preview.kind === "error" && (
            <div className="mt-3.5 text-[12.5px] leading-relaxed text-rose-600 dark:text-rose-400">
              Couldn’t preview the delete: {preview.error}
            </div>
          )}
          {preview.kind === "ready" && (
            <>
              <ImpactPanel lines={[preview.local.summary, ...preview.local.details]} />
              {preview.local.warnings.length > 0 && <Lines tone="amber" lines={preview.local.warnings} />}
              {offerRemote && (
                <label className="mt-3 flex cursor-pointer items-center gap-2.5 rounded-lg border border-black/10 px-3 py-2.5 text-[12.5px] text-neutral-700 [overflow-wrap:anywhere] dark:border-white/10 dark:text-neutral-200">
                  <input
                    type="checkbox"
                    checked={withRemote}
                    onChange={(e) => setWithRemote(e.target.checked)}
                    aria-describedby="delete-branch-remote-impact"
                    className={cn("h-4 w-4 flex-none accent-rose-500", focusRing)}
                  />
                  <span className="min-w-0">Also delete {remoteRef} on the remote</span>
                </label>
              )}
              {/* Live, so ticking announces the remote consequence to screen readers. */}
              <div id="delete-branch-remote-impact" aria-live="polite">
                {both && remote && <Lines tone="rose" lines={[...remote.preview.details, ...remote.preview.warnings]} />}
              </div>
            </>
          )}
          <div className="mt-5 flex gap-2.5">
            <button type="button" onClick={close} className={cn(LARGE_SECONDARY_BUTTON, "flex-1")}>
              Cancel
            </button>
            <button
              ref={deleteRef}
              type="button"
              onClick={() =>
                preview.kind === "ready" &&
                start(
                  preview.local.expectedOid,
                  both && req.alsoRemote && remote ? { ...req.alsoRemote, oid: remote.oid } : null,
                )
              }
              disabled={preview.kind !== "ready" || running}
              className={cn(LARGE_DANGER_BUTTON, "flex-1")}
            >
              {both ? "Delete both" : "Delete branch"}
            </button>
          </div>
          {running && (
            <div className="mt-2.5 text-center text-[11.5px] text-neutral-400">
              Another delete is still finishing — this will be ready in a moment.
            </div>
          )}
        </>
      )}

      {phase === "running" && (
        <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
          You can close this window — the result will show up as a notification.
        </div>
      )}

      {phase !== "configure" && (
        <StepList
          rows={rows.map((label, i) => {
            const failed = phase === "error" && i === failedAt;
            return {
              label,
              status: failed ? "failed" : stepStatus(i, reached, phase === "done"),
              note: failed ? message : undefined,
            };
          })}
        />
      )}

      {phase === "error" && (
        <button type="button" autoFocus onClick={close} className={cn(LARGE_SECONDARY_BUTTON, "mt-5 w-full")}>
          Close
        </button>
      )}
    </ModalFrame>
  );
}

const LINE_TONES = {
  amber: "border-amber-500/25 bg-amber-500/[0.08] text-neutral-700 dark:text-neutral-200",
  rose: "border-rose-500/25 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300",
} as const;

function Lines({ lines, tone }: { lines: string[]; tone: keyof typeof LINE_TONES }) {
  return (
    <div className={cn("mt-3 flex gap-2.5 rounded-lg border px-3 py-2.5 text-[12px] leading-relaxed", LINE_TONES[tone])}>
      {tone === "amber" && <WarningIcon className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />}
      <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
        {/* Snapshot text; never reorders while the dialog is open. */}
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  );
}
