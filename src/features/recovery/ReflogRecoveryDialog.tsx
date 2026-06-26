import { useEffect } from "react";
import type { ReflogEntry } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useBranchOp } from "@/components/chrome/overlays/shared";
import { ReflogEntryRow } from "./ReflogEntryRow";

export const ReflogRecoveryDialog = () => {
  const open = useUi((s) => s.recoveryOpen);
  const close = useUi((s) => s.closeRecovery);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const entries = useRepo((s) => s.reflogEntries);
  const loading = useRepo((s) => s.reflogLoading);
  const error = useRepo((s) => s.reflogError);
  const loadReflog = useRepo((s) => s.loadReflog);
  const createBranchAt = useRepo((s) => s.createBranchAt);
  const checkoutDetached = useRepo((s) => s.checkoutDetached);
  const run = useBranchOp();

  useEffect(() => {
    if (open) void loadReflog();
  }, [loadReflog, open]);

  if (!open) return null;

  const createBranch = (entry: ReflogEntry, defaultName: string) => {
    close();
    requestPrompt({
      title: `Create recovery branch at ${entry.shortOid}`,
      message: "The branch is created at the reflog commit and checked out.",
      placeholder: "recovery/branch-name",
      defaultValue: defaultName,
      confirmLabel: "Create branch",
      onSubmit: (name) => void run(() => createBranchAt(name, entry.oid)),
    });
  };

  const checkout = (entry: ReflogEntry) => {
    close();
    void run(() => checkoutDetached(entry.oid));
  };

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/30 backdrop-blur-sm"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[min(720px,calc(100vh-56px))] w-[min(820px,calc(100vw-48px))] flex-col rounded-2xl border border-black/10 bg-white shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="border-b border-black/10 px-5 py-4 dark:border-white/10">
          <div className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">Reflog recovery</div>
          <div className="mt-1 text-[12.5px] leading-relaxed text-neutral-400">
            Recent HEAD and branch movements. Recovery works while the target commit still exists locally.
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {loading ? (
            <div className="px-5 py-8 text-center text-[13px] text-neutral-400">Loading reflog…</div>
          ) : error ? (
            <div className="px-5 py-8 text-center text-[13px] text-rose-500">{error}</div>
          ) : entries.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] text-neutral-400">No reflog entries found.</div>
          ) : (
            entries.map((entry, index) => (
              <ReflogEntryRow
                key={`${entry.selector || entry.shortSelector}-${entry.oid}-${index}`}
                entry={entry}
                onBranch={createBranch}
                onCheckout={checkout}
              />
            ))
          )}
        </div>
        <div className="flex justify-end border-t border-black/10 px-5 py-3 dark:border-white/10">
          <button
            onClick={close}
            className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
