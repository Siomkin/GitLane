// Everything that contacts a remote: fetch, pull, push, publish, force-push and
// remote-branch deletion. All of it runs inside the shared net mutex; fetch is
// the one joinable operation and owns the coalescing transport below.

import { api, BranchKind } from "@/lib/api";
import { branchWebUrl } from "@/lib/forgeUrls";
import { friendlyGitError } from "@/lib/gitError";
import { openExternalUrl } from "@/lib/openExternal";
import { pushRemoteForBranch, remoteNameForUpstream } from "@/lib/remoteAccounts";
import { useNotifications } from "@/store/notifications";
import { useUi } from "@/store/ui";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";
import { authFor, trackNet } from "./net";
import {
  captureOwner,
  localBranchOid,
  ownerIsCurrent,
  refreshIfCurrent,
  releaseLoadingIfCurrent,
  runOp,
  toastWriteError,
} from "./shared";

export function createRemoteActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "pushBranch"
  | "publishBranch"
  | "deleteRemoteBranch"
  | "forcePush"
  | "fetch"
  | "pull"
  | "push"
> {
  // The remote a push of `branch` targets — its configured remote from the
  // branch list, with the backend's "origin" fallback.
  const pushRemoteOf = (branch: string) =>
    pushRemoteForBranch(get().branches.find((b) => b.kind === BranchKind.Local && b.name === branch));
  // Git rejects concurrent fetches when both processes prepare the same
  // remote-tracking ref update from the same old oid. Coalesce every in-app
  // fetch for the displayed repo onto one transport promise; the backend also
  // retries once for the equivalent race with an external git process.
  let fetchTransport: { path: string; promise: Promise<unknown> } | null = null;

  return {
    pushBranch: (branch) =>
      runOp(get, async (summary) => {
        const expectedOid = localBranchOid(get, branch);
        const remote = pushRemoteOf(branch);
        const auth = authFor(remote);
        await trackNet(set, get, () => api.pushBranch(
          summary.path,
          branch,
          expectedOid,
          auth,
        ));
        return `Pushed ${branch}`;
      }),

    publishBranch: (branch, upstream) =>
      runOp(get, async (summary) => {
        const remote = remoteNameForUpstream(
          upstream,
          get().remotes.map((r) => r.name),
        );
        const expectedOid = localBranchOid(get, branch);
        const auth = authFor(remote);
        await trackNet(set, get, () => api.publishBranch(
          summary.path,
          branch,
          expectedOid,
          upstream,
          auth,
        ));
        return `Published ${branch} to ${upstream}`;
      }),

    deleteRemoteBranch: (remote, branch, expectedOid) =>
      runOp(get, async (summary) => {
        const auth = authFor(remote);
        await trackNet(set, get, () => api.deleteRemoteBranch(summary.path, remote, branch, expectedOid, auth));
        return `Deleted ${remote}/${branch}`;
      }),

    forcePush: (branch, preview) =>
      runOp(get, async (summary) => {
        const auth = authFor(preview.remote);
        await trackNet(set, get, () => api.forcePush(
          summary.path,
          branch,
          preview.expectedOid,
          preview,
          auth,
        ));
        return `Force-pushed ${branch} (with lease)`;
      }),

    fetch: async (opts) => {
      const { summary, forge } = get();
      if (!summary) return false;
      const owner = captureOwner(summary);
      // The operation owner: every post-await store write below is guarded on
      // the displayed repo still being this one, so a fetch that outlives a
      // repo switch can't clear the new repo's loading lifecycle or refresh the
      // wrong checkout. Toast plumbing is global UI and stays unguarded.
      const opPath = summary.path;
      // A fetch can outlive a repo switch. Never start another app fetch while
      // it is still updating refs (linked worktrees may share those refs). The
      // ActionBar disables the new repo's network buttons for this short window.
      if (fetchTransport && fetchTransport.path !== opPath) return false;
      // A quiet (background) fetch doesn't hold global `loading` or raise
      // notifications; `fetchingPath` drives the Fetch-button spinner, while
      // `netOps` remains the scheduler's overlap signal. It also must not clear
      // an unrelated `error`.
      if (!opts?.quiet) set({ loading: true, error: null });
      const only = get().remotes.length === 1 ? get().remotes[0].name : null;
      const notes = useNotifications.getState();
      const toastId = opts?.quiet
        ? null
        : notes.notify({
            kind: "progress",
            title: only ? `Fetching ${only}…` : "Fetching…",
            body: forge?.host ? `Contacting ${forge.host}` : undefined,
            progress: "indeterminate",
          });
      try {
        // One {remote, account} pair per fetch URL with inline auth (GL-129);
        // remotes resolved to system helpers / SSH are omitted.
        const remoteAccounts = get()
          .remotes.map((r) => ({ remote: r.name, auth: authFor(r.name, "fetch") }))
          .filter((pair): pair is { remote: string; auth: NonNullable<typeof pair.auth> } =>
            pair.auth !== null,
          );
        let transport = fetchTransport?.promise;
        if (!transport) {
          transport = trackNet(set, get, () => api.fetch(summary.path, remoteAccounts));
          fetchTransport = { path: opPath, promise: transport };
          set({ fetchingPath: opPath });
          const clearTransport = () => {
            if (fetchTransport?.promise !== transport) return;
            fetchTransport = null;
            if (get().fetchingPath === opPath) set({ fetchingPath: null });
          };
          void transport.then(clearTransport, clearTransport);
        }
        await transport;
      } catch (e) {
        // Replay any re-sync deferred while this fetch held `loading` (GL-20
        // review). A quiet fetch held nothing, so it has no state to restore.
        if (!opts?.quiet) releaseLoadingIfCurrent(set, get, owner, true);
        if (toastId !== null) {
          notes.dismiss(toastId);
          useUi.getState().showToast(e, "error");
        } else {
          console.warn("auto-fetch failed", friendlyGitError(e));
        }
        return false;
      }
      if (opts?.quiet) {
        // The fetch rewrote FETCH_HEAD (and any updated remote refs) under
        // .git, so the watcher fires its own quiet re-sync — skip the
        // foreground refresh (and its PR reload) entirely. No `loading` was
        // held, so there is nothing to clear or flush.
        return true;
      }
      // Success is silent: drop the in-flight progress card. The graph refresh
      // (and the Fetch-button spinner clearing) are the confirmation.
      if (toastId !== null) notes.dismiss(toastId);
      if (!ownerIsCurrent(get, owner)) {
        // Switched repos mid-fetch: the new repo's load owns `loading` now.
        return true;
      }
      releaseLoadingIfCurrent(set, get, owner);
      await refreshIfCurrent(get, owner);
      return true;
    },

    pull: async () => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      // Same ownership rule as `fetch`: post-await reads/refresh are guarded on
      // the repo this pull started on.
      const head = get().branches.find((b) => b.kind === BranchKind.Local && b.isHead);
      const remote = head?.upstreamRemote ?? "origin";
      const branch = head?.name ?? "HEAD";
      const upstream = head?.upstream ?? `${remote}/${branch}`;
      const pullSource = remote === "." ? `local branch ${upstream}` : upstream;
      const notes = useNotifications.getState();
      // Claim the transport before painting progress. A context-menu pull can
      // bypass the ActionBar's disabled state; if fetch/push already owns the
      // mutex, surface only the actionable busy error — never flash a progress
      // card for work that did not start.
      let transport: Promise<string>;
      try {
        if (!head?.name || !head.target) {
          throw new Error("Cannot pull: HEAD is not an attached branch with a commit.");
        }
        const auth = authFor(remote, "fetch");
        transport = trackNet(set, get, () => api.pull(
          summary.path,
          head.name,
          head.target!,
          auth,
        ));
      } catch (e) {
        useUi.getState().showToast(e, "error");
        return;
      }
      const toastId = notes.notify({
        kind: "progress",
        title: remote === "." ? "Pulling locally…" : `Pulling ${remote}…`,
        body: `from ${pullSource}`,
        progress: "indeterminate",
      });
      try {
        await transport;
      } catch (e) {
        notes.dismiss(toastId);
        // The merge leg mutates the index, so a stranded lock can fail a pull.
        toastWriteError(get, e, () => get().pull());
        return;
      }
      // Success is silent: drop the progress card; the graph refresh is enough.
      notes.dismiss(toastId);
      if (!ownerIsCurrent(get, owner)) {
        return;
      }
      await refreshIfCurrent(get, owner);
    },

    push: async () => {
      const { summary, forge } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      // Push the captured HEAD branch explicitly to its configured remote and
      // send that remote's account (GL-129). Capture the ahead count *before*
      // the push so the success toast can report how many commits went out.
      const head = get().branches.find((b) => b.kind === BranchKind.Local && b.isHead);
      const remote = pushRemoteForBranch(head);
      const localPush = remote === ".";
      // The explicit push follows the configured upstream, whose name can differ
      // from the local branch. Named remotes encode it as "remote/branch"; a local
      // `.` upstream is already the bare local branch name. A triangular local push
      // (`pushRemote=.` with a non-local upstream) instead targets the same-named
      // local branch, matching the backend's push-destination resolution.
      const remoteBranch =
        localPush
          ? (head?.upstreamRemote === "." ? head.upstream : null) ?? head?.name ?? "HEAD"
          : head?.upstream && head.upstream.startsWith(`${remote}/`)
            ? head.upstream.slice(remote.length + 1)
            : (head?.name ?? "HEAD");
      const aheadBefore = head?.sync?.ahead ?? 0;
      const target = localPush ? `local branch ${remoteBranch}` : `${remote}/${remoteBranch}`;
      const notes = useNotifications.getState();
      // As with pull, claim the store mutex before creating progress so direct
      // commit-and-push callers get one busy error and no misleading flash.
      let transport: Promise<string>;
      try {
        if (!head?.name || !head.target) {
          throw new Error("Cannot push: HEAD is not an attached branch with a commit.");
        }
        const headName = head.name;
        const headTarget = head.target;
        const auth = authFor(remote);
        transport = trackNet(set, get, () => api.pushBranch(
          summary.path,
          headName,
          headTarget,
          auth,
        ));
      } catch (e) {
        useUi.getState().showToast(e, "error");
        return;
      }
      // git push doesn't stream progress through our transport, so the toast is
      // indeterminate ("working") until the invoke resolves, then morphs into a
      // success card when a View action exists; otherwise dismisses silently.
      const toastId = notes.notify({
        kind: "progress",
        title: localPush ? "Pushing locally…" : `Pushing to ${remote}…`,
        body: `to ${target}`,
        progress: "indeterminate",
      });
      try {
        await transport;
      } catch (e) {
        // Drop the in-flight progress toast; the error keeps its own persistent,
        // scrollable toast (via the legacy forwarder → friendlyGitError).
        notes.dismiss(toastId);
        useUi.getState().showToast(e, "error");
        return;
      }
      // The push landed. Keep a success card only when there's a View action
      // (open the remote); otherwise drop the progress toast silently.
      const webUrl = localPush ? null : branchWebUrl(forge, remoteBranch);
      if (webUrl) {
        notes.update(toastId, {
          kind: "success",
          title:
            aheadBefore > 0
              ? `Pushed ${aheadBefore} commit${aheadBefore === 1 ? "" : "s"}`
              : `Pushed to ${remote}`,
          body: `to ${target}`,
          progress: undefined,
          duration: 5000,
          actions: [{ label: `View on ${forge?.forge ?? "web"}`, onClick: () => openExternalUrl(webUrl) }],
        });
      } else {
        notes.dismiss(toastId);
      }
      // Best-effort: `refresh` never rejects (it reports success as a boolean),
      // and the filesystem watcher re-syncs anyway — the toast above doesn't
      // depend on it.
      await refreshIfCurrent(get, owner);
    },
  };
}
