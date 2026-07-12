import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteInfo } from "@/lib/api";
import { detectRemoteUrl } from "@/lib/remotes";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useUi } from "@/store/ui";
import { Spinner } from "@/components/ui/Loading";
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
  const listRemotes = useRepo((s) => s.listRemotes);
  const addRemote = useRepo((s) => s.addRemote);
  const setRemoteUrl = useRepo((s) => s.setRemoteUrl);
  const removeRemote = useRepo((s) => s.removeRemote);
  const accounts = useAccounts((s) => s.accounts);
  const forgeAuth = useAccounts((s) => s.forgeAuth);
  const loadForgeAuth = useAccounts((s) => s.loadForgeAuth);
  const repoRemoteAccountIds = useAccounts((s) => s.repoRemoteAccountIds);
  const setRemoteAccount = useAccounts((s) => s.setRemoteAccount);
  // GitLab remotes authenticate via glab / a stored token rather than a gh
  // account, so their PR account label comes from `gitlabPr()` (GL-145).
  const gitlabAccountLabel = useAccounts((s) => s.gitlabPr().label);
  // Bitbucket remotes authenticate via a stored token (no gh account), so their
  // label comes from `bitbucketPr()` (GL-141) — same pattern as GitLab.
  const bitbucketAccountLabel = useAccounts((s) => s.bitbucketPr().label);
  const showToast = useUi((s) => s.showToast);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const path = summary?.path;

  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous re-entry guard (busy state lags a render) and a generation
  // counter so a slow list response can't overwrite a newer repo's remotes.
  const busyRef = useRef(false);
  const loadGen = useRef(0);

  const reload = useCallback(async () => {
    if (!path) return;
    const gen = ++loadGen.current;
    try {
      const list = await listRemotes();
      if (gen !== loadGen.current) return; // superseded (e.g. repo switched)
      setRemotes(list);
      setError(null);
    } catch (e) {
      // Drop the stale list and surface an error rather than rendering the
      // previous repo's remotes (or a misleading "No remotes configured").
      if (gen === loadGen.current) {
        setRemotes([]);
        setError(String(e));
      }
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [path, listRemotes]);

  // On repo switch, clear the previous repo's list immediately so a slow (or
  // failing) load for the new repo can't leave stale rows on screen.
  useEffect(() => {
    setLoading(true);
    setRemotes([]);
    setError(null);
    void reload();
  }, [reload]);

  // The per-remote account notes reflect the forge CLI probes (e.g. a glab
  // sign-in) — make sure they're loaded (cached; no re-probe when present).
  useEffect(() => {
    void loadForgeAuth();
  }, [loadForgeAuth]);

  // Serialise mutations; reload from git config and refresh the repo on success.
  // Returns whether the op succeeded so forms can stay open (keeping the user's
  // input) on failure instead of dismissing optimistically.
  const run = async (action: () => Promise<unknown>, failure: string): Promise<boolean> => {
    if (busyRef.current || !path) return false;
    const startPath = path;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
      // The repo may have switched while git ran — don't reload the old repo's
      // list into the new repo's view; the path-change effect already loaded it.
      if (useRepo.getState().summary?.path !== startPath) return true;
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
    run(() => addRemote(name, url), `Couldn't add ${name}`);
  const handleSave = (name: string, url: string) =>
    run(() => setRemoteUrl(name, url), `Couldn't update ${name}`);
  const handleRemove = (remote: RemoteInfo) =>
    requestConfirm({
      title: `Remove remote “${remote.name}”?`,
      message:
        "It will be removed from this repository. Tracking branches that reference it stay until pruned.",
      confirmLabel: "Remove remote",
      danger: true,
      onConfirm: () => void run(() => removeRemote(remote.name), `Couldn't remove ${remote.name}`),
    });

  const defaultRemote = remotes.find((r) => r.isDefault) ?? remotes[0];
  const defaultRemoteAccountId = defaultRemote ? repoRemoteAccountIds[defaultRemote.name] : null;
  const defaultRemoteAccount = accounts.find((a) => a.id === defaultRemoteAccountId) ?? null;
  // Pick the label source by the default remote's forge so they never mix: a
  // GitLab remote uses its glab / stored-token label and a Bitbucket remote its
  // stored-token label (never a stray legacy gh binding, which would show a
  // github account + a false "enabled"); everything else uses the bound gh
  // account. All null leaves the card unbound.
  const defaultRemoteProvider = defaultRemote
    ? detectRemoteUrl(defaultRemote.pushUrl || defaultRemote.fetchUrl).provider
    : null;
  const accountLabel =
    defaultRemoteProvider === "gitlab"
      ? gitlabAccountLabel
      : defaultRemoteProvider === "bitbucket"
        ? bitbucketAccountLabel
        : defaultRemoteAccount
          ? `@${defaultRemoteAccount.login}`
          : null;

  if (!summary) return null;

  return (
    <div className="max-w-[760px]">
      <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Remotes</h2>
      <p className="mt-2 text-pretty text-[14.5px] text-neutral-500 dark:text-neutral-400">
        Git remotes for{" "}
        <span className="font-mono text-[13px] text-neutral-700 dark:text-neutral-300">{repoLeaf(summary.workdir)}</span>.
        The provider on the default push remote drives pull-request availability.
      </p>

      {loading ? (
        <div className="mt-7 flex items-center gap-2 text-[13px] text-neutral-500 dark:text-neutral-400">
          <Spinner className="h-4 w-4" /> Loading remotes…
        </div>
      ) : error ? (
        <div className="mt-7 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] p-5 text-[13px] text-rose-700 dark:text-rose-300">
          Couldn't load remotes for this repository.
          <div className="mt-1 font-mono text-[12px] text-rose-600/80 dark:text-rose-400/80">{error}</div>
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

      {!loading && !error && (
        <>
          <div className="mt-8 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
            Configured remotes
          </div>
          <div className="mt-3 flex flex-col gap-2.5">
            {remotes.map((r) => (
              <RemoteRow
                key={r.name}
                remote={r}
                busy={busy}
                accounts={accounts}
                forgeAuth={forgeAuth}
                selectedAccountId={repoRemoteAccountIds[r.name] ?? null}
                onPickAccount={(remote, id) => void setRemoteAccount(remote, id)}
                onSave={handleSave}
                onRemove={handleRemove}
              />
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
