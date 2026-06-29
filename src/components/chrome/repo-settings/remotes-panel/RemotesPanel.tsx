import { useCallback, useEffect, useRef, useState } from "react";
import { api, type RemoteInfo } from "../../../../lib/api";
import { useRepo } from "../../../../store/repo";
import { useAccounts } from "../../../../store/accounts";
import { useUi } from "../../../../store/ui";
import { Spinner } from "../../../ui/Loading";
import { RemoteRow } from "./RemoteRow";
import { RemoteSummaryCard } from "./RemoteSummaryCard";
import { AddRemoteForm } from "./AddRemoteForm";
import { PrAvailabilityLegend } from "./PrAvailabilityLegend";

const repoLeaf = (workdir: string | null | undefined): string =>
  workdir?.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "this repository";

/** Repository settings → Remotes. Lists the repo's configured remotes with their
 * provider/PR capability and supports add / repoint / remove. Git config is the
 * source of truth — every mutation reloads the list, and the filesystem watcher
 * refreshes the toolbar provider indicator on its own. */
export const RemotesPanel = () => {
  const summary = useRepo((s) => s.summary);
  const refreshRepo = useRepo((s) => s.refresh);
  const repoAccountRef = useAccounts((s) => s.repoAccountRef);
  const showToast = useUi((s) => s.showToast);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const path = summary?.path;

  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Synchronous re-entry guard (busy state lags a render) and a generation
  // counter so a slow list response can't overwrite a newer repo's remotes.
  const busyRef = useRef(false);
  const loadGen = useRef(0);

  const reload = useCallback(async () => {
    if (!path) return;
    const gen = ++loadGen.current;
    try {
      const list = await api.listRemotes(path);
      if (gen !== loadGen.current) return; // superseded (e.g. repo switched)
      setRemotes(list);
    } catch (e) {
      if (gen === loadGen.current) showToast(`Couldn't load remotes: ${String(e)}`, "error");
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [path, showToast]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  // Serialise mutations; reload from git config and refresh the repo on success.
  // Returns whether the op succeeded so forms can stay open (keeping the user's
  // input) on failure instead of dismissing optimistically.
  const run = async (action: () => Promise<unknown>, failure: string): Promise<boolean> => {
    if (busyRef.current || !path) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
      await reload();
      // Refresh the repo's forge/provider state so the toolbar indicator and PR
      // gating react immediately — e.g. adding the first GitHub remote flips the
      // toolbar out of "No remote" without waiting on the filesystem watcher.
      void refreshRepo();
      return true;
    } catch (e) {
      showToast(`${failure}: ${String(e)}`, "error");
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleAdd = (name: string, url: string) =>
    run(() => api.addRemote(path!, name, url), `Couldn't add ${name}`);
  const handleSave = (name: string, url: string) =>
    run(() => api.setRemoteUrl(path!, name, url), `Couldn't update ${name}`);
  const handleRemove = (remote: RemoteInfo) =>
    requestConfirm({
      title: `Remove remote “${remote.name}”?`,
      message:
        "It will be removed from this repository. Tracking branches that reference it stay until pruned.",
      confirmLabel: "Remove remote",
      danger: true,
      onConfirm: () => void run(() => api.removeRemote(path!, remote.name), `Couldn't remove ${remote.name}`),
    });

  const defaultRemote = remotes.find((r) => r.isDefault) ?? remotes[0];
  const accountLabel = repoAccountRef?.login ? `@${repoAccountRef.login}` : null;

  if (!summary) return null;

  return (
    <div className="max-w-[760px]">
      <h2 className="text-[28px] font-bold tracking-tight text-neutral-900 dark:text-white">Remotes</h2>
      <p className="mt-2 text-pretty text-[14.5px] text-neutral-500 dark:text-neutral-400">
        Git remotes for{" "}
        <span className="font-mono text-[13px] text-neutral-700 dark:text-neutral-300">{repoLeaf(summary.workdir)}</span>.
        The provider on the default push remote drives pull-request availability.
      </p>

      {loading ? (
        <div className="mt-7 flex items-center gap-2 text-[13px] text-neutral-500 dark:text-neutral-400">
          <Spinner className="h-4 w-4" /> Loading remotes…
        </div>
      ) : remotes.length === 0 ? (
        <div className="mt-7 rounded-xl border border-black/[0.07] bg-black/[0.02] p-5 text-[13px] text-neutral-500 dark:border-white/[0.08] dark:bg-black/20 dark:text-neutral-400">
          No remotes configured. Add one to enable fetch, push, and pull requests.
        </div>
      ) : (
        defaultRemote && (
          <div className="mt-7">
            <RemoteSummaryCard remote={defaultRemote} accountLabel={accountLabel} />
          </div>
        )
      )}

      {!loading && (
        <>
          <div className="mt-8 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
            Configured remotes
          </div>
          <div className="mt-3 flex flex-col gap-2.5">
            {remotes.map((r) => (
              <RemoteRow key={r.name} remote={r} busy={busy} onSave={handleSave} onRemove={handleRemove} />
            ))}
            <AddRemoteForm busy={busy} onAdd={handleAdd} />
          </div>

          <div className="mt-8">
            <PrAvailabilityLegend />
          </div>
        </>
      )}
    </div>
  );
};
