// The toolbar's view model (GL-182): every store selector, the one-at-a-time
// network-op busy state, branch/PR/provider derivations, PR badge polling, and
// the command callbacks — extracted so `ActionBar.tsx` stays a composition of
// presentational leaves. No JSX here; the component owns only render structure
// and the DOM-anchored navigator dismissal.

import { useEffect, useRef, useState } from "react";
import { currentBranchSyncView, defaultPublishTarget } from "../../../lib/branchSync";
import type { CurrentBranchSyncView } from "../../../lib/branchSync";
import { changeTotal, summarizeChanges } from "../../../lib/changeSummary";
import type { LeftTab } from "../../../lib/ui";
import type { PullRequest } from "../../../lib/prs";
import { BranchKind, type RepoForge, type RepoSummary } from "../../../lib/api";
import { useAccounts } from "../../../store/accounts";
import { usePulls } from "../../../store/pulls";
import { prListRequestKey } from "../../../store/pullsQueue";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import type { SettingsTab } from "../../../store/ui";
import { deriveProviderState } from "./provider-indicator";
import type { ProviderState } from "./provider-indicator";
import { currentBranchLabel, findOpenPr, isPrForge, transportConfigured } from "./actionBarModel";

/** Network ops that surface a per-button spinner driven by their command promise. */
export type NetOp = "fetch" | "pull" | "push";

const PR_BADGE_REFRESH_MS = 60_000;

export interface ActionBarModel {
  summary: RepoSummary | null;
  forge: RepoForge | null;
  loading: boolean;
  /** The in-flight network op (its button shows the spinner), if any. */
  busy: NetOp | null;
  showPulls: boolean;
  workCount: number;
  prCount: number;
  currentBranch: string;
  currentSync: CurrentBranchSyncView;
  openPr: PullRequest | undefined;
  providerState: ProviderState | null;
  accountsError: string | null;
  navOpen: boolean;
  terminalVisible: boolean;
  // Commands
  selectTab: (tab: LeftTab) => void;
  toggleNav: () => void;
  closeNav: () => void;
  runFetch: () => void;
  runPull: () => void;
  runPush: () => void;
  stash: () => void;
  openCreateBranch: () => void;
  openRecovery: () => void;
  toggleTerminal: () => void;
  openSettings: (tab?: SettingsTab) => void;
  openRepoSettings: () => void;
  selectPr: (num: number) => void;
}

export function useActionBarModel(): ActionBarModel {
  const summary = useRepo((state) => state.summary);
  const forge = useRepo((state) => state.forge);
  const remotes = useRepo((state) => state.remotes);
  const branches = useRepo((state) => state.branches);
  const loading = useRepo((state) => state.loading);
  const fetch = useRepo((state) => state.fetch);
  const pull = useRepo((state) => state.pull);
  const push = useRepo((state) => state.push);
  const publishBranch = useRepo((state) => state.publishBranch);
  const stash = useRepo((state) => state.stash);
  const changes = useRepo((state) => state.changes);
  const pullRequests = usePulls((state) => state.pullRequests);
  const loadPullRequests = usePulls((state) => state.loadPullRequests);
  const activeTab = useUi((state) => state.leftTab);
  const setLeftTab = useUi((state) => state.setLeftTab);
  const setCreateBranchOpen = useUi((state) => state.setCreateBranchOpen);
  const openSettings = useUi((state) => state.openSettings);
  const openRepoSettings = useUi((state) => state.openRepoSettings);
  const toggleTerminal = useUi((state) => state.toggleTerminal);
  const openRecovery = useUi((state) => state.openRecovery);
  const terminalVisible = useUi((state) => state.terminalView !== "hidden");
  const navOpen = useUi((state) => state.navOpen);
  const toggleNav = useUi((state) => state.toggleNav);
  const openNav = useUi((state) => state.openNav);
  const closeNav = useUi((state) => state.closeNav);
  const requestPrompt = useUi((state) => state.requestPrompt);
  const selectPr = useUi((state) => state.selectPr);
  const accounts = useAccounts((state) => state.accounts);
  const accountsError = useAccounts((state) => state.accountsError);
  const accountsLoading = useAccounts((state) => state.accountsLoading);
  const repoAccountRef = useAccounts((state) => state.repoAccountRef);
  // Whether GitLab MRs can be fetched (glab / stored token) — drives the provider
  // popover's connected-vs-needs-auth state for a GitLab repo (GL-145).
  const gitlabReady = useAccounts((state) => state.gitlabPr().ready);
  // Whether Bitbucket PRs can be fetched (stored token) — same connected-vs-
  // needs-auth signal for a Bitbucket repo (GL-141).
  const bitbucketReady = useAccounts((state) => state.bitbucketPr().ready);

  // Per-button in-flight state for the network ops. The store's single global
  // `loading` flag can't say which button is busy (and `pull`/`push` don't even
  // toggle it), so we track each spinner against its own awaited command promise.
  // `busyRef` is the synchronous re-entry guard — `busy` state lags a render, so
  // a fast double-click (or starting a second op before the first resolves)
  // would otherwise run twice and clear `busy` while the first is still in
  // flight. Only one network op runs at a time.
  const [busy, setBusy] = useState<NetOp | null>(null);
  const busyRef = useRef(false);
  const run = (key: NetOp, action: () => Promise<unknown>) => async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    try {
      await action();
    } catch (e) {
      // Store network actions surface their own failures (error toast) and
      // resolve; a rejection here is a contract violation. Log it rather than
      // leaving an unhandled rejection — the finally below already guarantees
      // the toolbar can never stay locked (GL-182 review).
      console.warn(`${key}: network action rejected`, e);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  // Distinct changed files (conflicts included), so the toolbar badge agrees
  // with the WIP row's per-type breakdown — a path staged *and* edited in the
  // worktree counts once, not twice.
  const workCount = changeTotal(summarizeChanges(changes));
  // Badge counts only open PRs — the list is fetched `--state all`, but a tab
  // badge should reflect what needs attention, not merged/closed history.
  const prCount = pullRequests.filter((pr) => pr.state === "open").length;

  const currentBranch = currentBranchLabel(summary);
  const currentSync = currentBranchSyncView(summary, branches);
  const openPr = findOpenPr(summary, pullRequests);

  // Remote-provider status: forge detection (backend) combined with PR/API auth
  // state and the remote URL's transport-auth signal. A GCM-backed HTTPS username
  // or SSH key means fetch/push can work even when provider PR auth is absent.
  const providerState: ProviderState | null = forge
    ? deriveProviderState(forge, {
        accounts,
        accountsError,
        accountsLoading,
        repoAccountRef,
        gitlabReady,
        bitbucketReady,
        transportConfigured: transportConfigured(remotes),
      })
    : null;

  // The PR badge is always visible in the toolbar, so keep its count warm even
  // before the PR panel opens. Foreground loads still happen in LeftPanel for a
  // visible spinner; these quiet loads just keep the badge current. The effect
  // is keyed by the primitives that actually own the polling identity — repo
  // path, forge kind, and the PR-API account the loads authenticate as
  // (GL-182; this effect carried the repo's last hook-lint warning).
  const repoPath = summary?.path ?? null;
  const forgeKind = forge?.kind ?? null;
  // The account identity behind `loadPullRequests` is `prAccountRef()` — the gh
  // binding for GitHub, but glab readiness / native keychain tokens for GitLab
  // and Bitbucket, which change WITHOUT `repoAccountRef` changing (saving or
  // deleting a provider token, glab auth flipping). Fold the resolved ref into
  // the same request key the pulls store computes, so any auth change re-arms
  // polling immediately instead of staying stale until the next tick (GL-184).
  // `gitlabReady` must ALSO key the effect: the glab zero-config path resolves
  // to a null account both before and after glab authenticates — only the
  // backend transport changes — so the request key alone can't see that flip.
  const prPollKey = useAccounts((state) => prListRequestKey(repoPath ?? "", state.prAccountRef()));
  useEffect(() => {
    if (!repoPath || !isPrForge(forgeKind)) return;
    void loadPullRequests(false, true);
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void loadPullRequests(false, true);
    }, PR_BADGE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [repoPath, forgeKind, prPollKey, gitlabReady, loadPullRequests]);

  // ⌘ + Option + F opens the navigator and focuses its filter (the input
  // autofocuses on mount). `code === "KeyF"` since Option+F yields "ƒ" on macOS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyF") {
        e.preventDefault();
        openNav();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openNav]);

  const selectTab = (tab: LeftTab) => {
    closeNav();
    setLeftTab(tab);
  };

  const runPush = () => {
    const branch = summary?.headBranch;
    if (branch && currentSync.needsPublishPrompt) {
      const info = branches.find((b) => b.kind === BranchKind.Local && b.name === branch);
      requestPrompt({
        title: `Publish ${branch}`,
        message: `Remote branch for ${branch} to push to and pull from.`,
        placeholder: "origin/branch",
        defaultValue: defaultPublishTarget(
          branches,
          branch,
          info?.upstream,
          info?.sync?.status !== "staleUpstream",
        ),
        confirmLabel: "Publish",
        onSubmit: (upstream) => void run("push", () => publishBranch(branch, upstream))(),
      });
      return;
    }
    void run("push", push)();
  };

  return {
    summary,
    forge,
    loading,
    busy,
    showPulls: activeTab === "pulls",
    workCount,
    prCount,
    currentBranch,
    currentSync,
    openPr,
    providerState,
    accountsError,
    navOpen,
    terminalVisible,
    selectTab,
    toggleNav,
    closeNav,
    runFetch: () => void run("fetch", fetch)(),
    runPull: () => void run("pull", pull)(),
    runPush,
    stash,
    openCreateBranch: () => setCreateBranchOpen(true),
    openRecovery,
    toggleTerminal,
    openSettings,
    openRepoSettings,
    selectPr,
  };
}
