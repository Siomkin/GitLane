// Opening a repository (GL-158: the tab/session actions live in
// repoTabActions.ts, the re-sync actions in repoRefreshActions.ts): the folder
// picker, the two-phase loadRepo swap, and the missing-repo recovery entry
// points (Locate… and init-in-place). The GL-108/GL-126 routing itself lives
// in repoMissing.ts; the ownership guards in repoGuards.ts.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, isRepoOpenError, type RepoSummary } from "@/lib/api";
import { useAccounts } from "./accounts";
import { migrateIdentityBindings } from "./identities";
import { flushPendingRefresh, graphRequestIsCurrent, repoSessionIsCurrent } from "./repoGuards";
import { createMissingRepoHandlers, errorText } from "./repoMissing";
import { publishRepoSwitch } from "./repoLifecycle/publishSwitch";
import { startRepoSideEffects } from "./repoLifecycle/sideEffects";
import {
  beginTabLifetime,
  endTabLifetime,
  ensureTabLifetime,
  openIntent,
  tabLifetimeIsCurrent,
  type TabLifetimeLease,
} from "./repoRequests";
import { persistRecents, persistSession } from "./repoSession";
import { unwatchRepo } from "./repoWatchQueue";
import { useUi } from "./ui";
import { INITIAL_GRAPH_LIMIT, type RepoGet, type RepoSet, type RepoState } from "./repoTypes";

export function createRepoLifecycleActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "pickAndOpen" | "loadRepo" | "locateMissingRepo" | "initMissingRepo"> {
  const { wentMissing, handleMissing, surfaceOpenFailure } = createMissingRepoHandlers(set, get);

  return {
    // Native folder picker → open whatever repo lives there.
    pickAndOpen: async () => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") {
        await get().loadRepo(picked);
      }
    },

    loadRepo: async (path: string, opts?: { replaceTab?: string }) => {
      // Claim the latest open intent before doing anything that can await. A newer
      // pick supersedes this one even if our open resolves later (GL-20 review).
      const intent = openIntent.claim();
      const initialPaths = get().openPaths;
      // Activating an existing tab owns that exact tab lifetime. Closing it
      // while open_repo is pending invalidates this lease, so the completion
      // cannot silently re-add the path. A genuinely new target has no tab
      // lifetime until phase 2 publishes it; the global open intent still gives
      // concurrent new opens their latest-pick ordering.
      // Snapshot every initially-live path because open_repo can canonicalize a
      // subdirectory/symlink pick to an already-open repository path. Once the
      // canonical summary arrives we can then prove that exact tab survived the
      // await, without coupling a genuinely new target to unrelated tabs.
      const initialTabOwners = new Map(
        initialPaths.map((openPath) => [openPath, ensureTabLifetime(openPath)]),
      );
      const targetOwner = initialTabOwners.get(path) ?? null;
      // In-place switches additionally own the source tab. If the source closes
      // while the destination is resolving, the operation no longer has a tab
      // to replace and must stand down instead of appending the destination.
      const replacementOwner = opts?.replaceTab
        ? initialTabOwners.get(opts.replaceTab) ?? null
        : null;
      const tabOwnerIsCurrent = (owner: TabLifetimeLease | null) =>
        owner === null ||
        (tabLifetimeIsCurrent(owner) && get().openPaths.includes(owner.path));
      const openOwnerIsCurrent = () =>
        openIntent.isCurrent(intent) &&
        tabOwnerIsCurrent(targetOwner) &&
        tabOwnerIsCurrent(replacementOwner);

      // Phase 1 — open the repo. This is a cheap libgit2 metadata read and the only
      // step that can fail "this isn't a repo". Crucially it touches NO shared
      // state: it doesn't bump the graph generation or raise the loading flags. So
      // a failed pick (invalid folder) can't supersede an in-flight load for the
      // repo that's still on screen, nor strand its summary over an empty graph —
      // it only surfaces the error, leaving the current repo (and any pending graph
      // request) untouched. See GL-20.
      let summary: RepoSummary;
      try {
        summary = await api.openRepo(path);
      } catch (e) {
        // Only surface the error if this is still the latest pick — a slow failed
        // open must not error over a repo the user has since switched to.
        if (openOwnerIsCurrent()) {
          // A vanished path gets the dedicated missing-repo state — tab click,
          // startup restore, and a recents open all funnel through here
          // (GL-108). Other failures keep the GL-20 behavior: error bar only,
          // the current repo untouched.
          const missing = isRepoOpenError(e) && e.kind !== "other" ? e.kind : null;
          if (missing) await handleMissing(path, missing, openOwnerIsCurrent);
          else set({ error: errorText(e) });
        }
        return;
      }
      // A newer pick superseded us while we were opening → drop this stale open so
      // it can't publish over the repo the user landed on.
      const canonicalTargetOwner = initialTabOwners.get(summary.path) ?? null;
      if (!openOwnerIsCurrent() || !tabOwnerIsCurrent(canonicalTargetOwner)) return;

      const published = publishRepoSwitch(set, get, summary, opts, replacementOwner);
      const { fileSelectionRequestId, generation, session } = published;

      startRepoSideEffects(set, get, summary, opts, intent, published, surfaceOpenFailure);

      // The graph is the heavy one — await it, then paint and pick the initial
      // selection once it lands, clearing the history skeleton.
      try {
        const graph = await api.commitGraph(summary.path, INITIAL_GRAPH_LIMIT);
        if (!graphRequestIsCurrent(get, generation, summary.path)) return;
        // Honor a selection the user made while the skeleton was up — the branch
        // navigator stays usable during the load, and picking a branch sets the
        // selection + revealTarget to its tip. Phase 2 cleared the selection, so a
        // non-null one here is a deliberate during-load pick; snapping it back to
        // the tip would scroll the graph to their branch while the inspector still
        // showed HEAD (GL-20 review). Its files were already fetched by the pick.
        const priorSelection = get().selectedCommit;
        // Only honor a during-load pick if its commit is actually in the loaded
        // graph window. A branch tip beyond the initial limit isn't in
        // `graph.commits`, so the graph couldn't scroll to it and the inspector
        // would fall back to the tip while `commitFiles` still belonged to the
        // picked SHA — mismatched metadata. Fall back to the tip (and drop the now
        // unreachable reveal) in that case (GL-20 review).
        const honorPrior =
          priorSelection != null && graph.commits.some((c) => c.id === priorSelection);
        // Default to the newest real commit, never a stash node: in-window stashes
        // are interleaved into `graph.commits` by time and a fresh stash sorts above
        // HEAD, so `commits[0]` is often the stash — selecting it would load its
        // files as a commit and mis-render the inspector.
        const selectedCommit = honorPrior
          ? priorSelection
          : graph.commits.find((c) => !c.stash)?.id ?? null;
        set({
          graph,
          selectedCommit,
          selectedCommits: honorPrior ? get().selectedCommits : selectedCommit ? [selectedCommit] : [],
          selectionAnchor: honorPrior ? get().selectionAnchor : selectedCommit,
          // Honoring the prior selection keeps its merged diff (immutable by oid);
          // collapsing to a single default commit drops it.
          ...(honorPrior ? {} : { commitFiles: [], selectionDiff: null, revealTarget: null }),
          graphLimit: INITIAL_GRAPH_LIMIT,
          graphLoading: false,
          loading: false,
        });
        // Commit-file loading is secondary to showing a usable history. Populate
        // the inspector after the graph is visible (only when we defaulted to the
        // tip — a during-load pick fetched its own files), and ignore a stale
        // response if the user switches repository/selection in the meantime.
        if (selectedCommit && !honorPrior) {
          void api
            .commitFiles(summary.path, selectedCommit)
            .then((commitFiles) => {
              if (
                repoSessionIsCurrent(get, summary.path, session) &&
                get().fileSelectionRequestId === fileSelectionRequestId &&
                get().selectedCommit === selectedCommit
              ) {
                set({ commitFiles });
              }
            })
            .catch(() => {});
        }
        // Replay any watcher/focus re-sync that arrived while this load held `loading`.
        flushPendingRefresh(get);
      } catch (e) {
        // Only clear the loading flags if this request still owns the active repo —
        // a newer load may have superseded us while the graph was in flight.
        if (!graphRequestIsCurrent(get, generation, summary.path)) return;
        // The repo can vanish between the open and the (slow) graph read —
        // classify before surfacing so even this window can't show the raw
        // libgit2 message (GL-108). Re-guard after the async probe.
        const missing = await wentMissing(summary.path, e);
        if (!graphRequestIsCurrent(get, generation, summary.path)) return;
        if (missing) {
          // `intent` (claimed at this loadRepo's start, before every await) is
          // the open-intent baseline: a competing switch bumps it, flipping the
          // token even before that switch publishes its summary/generation.
          const transitioned = await handleMissing(
            summary.path,
            missing,
            () => graphRequestIsCurrent(get, generation, summary.path) && openIntent.isCurrent(intent),
          );
          if (!transitioned && graphRequestIsCurrent(get, generation, summary.path)) {
            // A newer phase-1 open can suppress this missing transition without
            // yet owning the loading flags. Release the old graph shell so a
            // later failed pick cannot leave it stuck.
            set({ loading: false, graphLoading: false });
          }
        } else if (openIntent.isCurrent(intent)) {
          set({ loading: false, graphLoading: false, error: errorText(e) });
        } else {
          set({ loading: false, graphLoading: false });
        }
        flushPendingRefresh(get);
      }
    },

    // Locate… (GL-108): re-point a dead repository path at its new location.
    // With no argument it acts on the missing-repo tab state; the onboarding
    // "Recent" list passes its stale path explicitly, so both entry points
    // share the probe + per-repo binding migration.
    locateMissingRepo: async (fromPath) => {
      const stalePath = fromPath ?? get().missingRepo?.path;
      if (!stalePath) return;
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      // Probe the pick first (classified open) so a non-repo folder keeps the
      // missing state in place — and so the *normalized* repo path (not the raw
      // picked folder) keys the tab replacement and binding migration.
      let probe: RepoSummary;
      try {
        probe = await api.openRepo(picked);
      } catch (e) {
        useUi.getState().showToast(errorText(e), "error");
        return;
      }
      // The tab flow can be superseded while the picker/probe was up (Retry
      // succeeded, the tab was closed, or another repo opened) — don't rewrite
      // tabs/bindings for it. The recents flow carries its path explicitly.
      if (!fromPath && get().missingRepo?.path !== stalePath) return;
      if (probe.path !== stalePath) {
        // Carry the old path's per-repo bindings — the account ref + cached
        // identity read (accounts) and the applied profile + custom-email
        // overrides (profiles) — so relocating doesn't silently change how the
        // repo authenticates or commits. The repo's own git config moved with
        // the folder; these are the app-side maps keyed by path. Then replace
        // the stale tab in place (keeping its position; a no-op for a recents
        // entry that has no tab) and drop the dead recents entry — the open
        // below records the new location as active.
        const staleWasOpen = get().openPaths.includes(stalePath);
        const targetWasOpen = get().openPaths.includes(probe.path);
        if (staleWasOpen) endTabLifetime(stalePath);
        if (targetWasOpen) ensureTabLifetime(probe.path);
        else if (staleWasOpen) beginTabLifetime(probe.path);
        useAccounts.getState().migrateRepoBindings(stalePath, probe.path);
        migrateIdentityBindings(stalePath, probe.path);
        // The dead path may still hold a watch from before it went missing;
        // its tab is being re-keyed, so release the stale entry (GL-116).
        void unwatchRepo(stalePath);
        const openPaths = get().openPaths.includes(probe.path)
          ? get().openPaths.filter((p) => p !== stalePath)
          : get().openPaths.map((p) => (p === stalePath ? probe.path : p));
        const recents = get().recents.filter((r) => r.path !== stalePath);
        persistSession(openPaths, probe.path);
        persistRecents(recents);
        set({ openPaths, recents });
      }
      await get().loadRepo(probe.path);
    },

    // Initialize as git repo… (GL-153): the `notARepository` case's folder
    // still has the user's files, so this runs `git init` right where it
    // stands (no picker, no README/.gitignore scaffolding) and opens it — a
    // lighter recovery than Locate… for the common "the .git got deleted"
    // case.
    initMissingRepo: async () => {
      const missing = get().missingRepo;
      if (!missing || missing.kind !== "notARepository") return;
      if (get().initMissingRepoRunning) return;
      const { path } = missing;
      set({ initMissingRepoRunning: true });
      try {
        try {
          await api.initRepoInPlace(path);
        } catch (e) {
          const message = errorText(e);
          // The repo may have become openable while the confirm dialog was up
          // (another tool re-created `.git`, or a concurrent Retry succeeded).
          if (message.includes("already a Git repository") && get().missingRepo?.path === path) {
            await get().loadRepo(path);
            return;
          }
          useUi.getState().showToast(message, "error");
          return;
        }
        // The tab may have moved on while the (fast, local) init was in flight
        // — e.g. Remove/Retry/Locate… resolved it first. Don't stomp on that.
        if (get().missingRepo?.path !== path) return;
        await get().loadRepo(path);
      } finally {
        set({ initMissingRepoRunning: false });
      }
    },
  };
}
