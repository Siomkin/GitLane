// The app-wide keyboard dispatcher (GL-346): one document listener that matches
// keydowns against the registry in `lib/shortcuts` and runs the toolbar's
// existing commands. It lives beside `useActionBarModel` so the bindings reuse
// those closures verbatim — `runPush` carries the publish-prompt flow and the
// one-at-a-time transport guard, which a store-level action would have to
// duplicate.
//
// Precedence (spec: keyboard-shortcuts): text entry → open overlay → terminal
// focus → global binding. Anything more specific than an app-wide shortcut wins,
// so a shortcut can never fire while the user is typing.

import { useEffect } from "react";
import { isMac } from "@/lib/platform";
import { SHORTCUTS, ShortcutId, ShortcutKind, matchesEvent } from "@/lib/shortcuts";
import { deriveCenterView } from "@/app-shell/centerView";
import { useRepo } from "@/store/repo";
import { visualTabOrder } from "@/store/repoTab/tabOrder";
import { overlayOpen, useUi } from "@/store/ui";
import { workingUnionCompare } from "@/features/changes/merged-selection/mergedSelection";
import { COMMIT_DIFF_ROUTE, commitDiffRouteFromRepo, workingRange } from "@/store/selection";
import { inspectParentRangeFromGraph } from "@/lib/inspectParent";
import { AiActionScopeKind, scopeFromSelection } from "@/features/agents/ai-actions";
import type { ActionBarModel, NetOp } from "./action-bar/useActionBarModel";

/** Bindings that still work while the terminal has focus. Everything else would
 *  steal a chord the shell wants — on Windows/Linux `mod` is Ctrl, so Ctrl+B,
 *  Ctrl+P and friends belong to the program running in the PTY. */
const TERMINAL_SAFE: readonly string[] = [
  ShortcutId.RepoTabByIndex,
  ShortcutId.RepoTabPrev,
  ShortcutId.RepoTabNext,
  ShortcutId.ToggleTerminal,
];

function isTextEntry(target: EventTarget | null): boolean {
  // `closest` also catches a node nested inside a contenteditable, which a
  // tagName check on the target alone would miss.
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("[data-terminal-host]") !== null;
}

interface Command {
  /** Returning `false` means the binding decided to do nothing, so the key is
   *  left for whatever else may want it. */
  run: (event: KeyboardEvent) => boolean | void;
  /** Whether the binding does anything right now; a disabled binding falls
   *  through untouched (no `preventDefault`). */
  enabled?: () => boolean;
}

type Commands = Partial<Record<ShortcutId, Command>>;

/** The center pane the app is showing right now, from the same derivation the
 *  layout uses — so "am I already on the graph?" can't drift from what renders. */
function centerView() {
  const repo = useRepo.getState();
  const ui = useUi.getState();
  return deriveCenterView({
    inConflict: !!repo.operation,
    leftTab: ui.leftTab,
    comparing: !!repo.compare,
    fileHistoryOpen: !!repo.fileHistory,
    stackedReviewOpen: !!ui.stackedReview,
    fileViewOpen: !!repo.fileView,
    changesAll: ui.changesAll,
    selectedFileSource: repo.selectedFile?.source ?? null,
  });
}

/** The tab the strip highlights — a missing repo owns its tab like a live one
 *  (GL-108), and switching away from it is the whole point of the shortcut. */
function activeTabPath(): string | null {
  const { summary, missingRepo } = useRepo.getState();
  return summary?.path ?? missingRepo?.path ?? null;
}

/** Activate an open repository tab by position. `mod+9` selects the last tab,
 *  the convention every tabbed browser uses. Returns false when there is no such
 *  tab (or it is already active), so the key isn't swallowed for nothing. */
function activateTabAt(index: number): boolean {
  const { openPaths, tabInfoByPath, loadRepo } = useRepo.getState();
  const path = visualTabOrder(openPaths, tabInfoByPath, activeTabPath())[index];
  if (!path || path === activeTabPath()) return false;
  void loadRepo(path);
  return true;
}

/** What ⌘↵ reviews, in the order the inspector itself resolves the selection:
 *  commits picked together with the WIP row, the WIP row alone, a multi-commit
 *  selection, then a single commit. With nothing selected it falls back to the
 *  working changes, which is the only thing left worth reviewing. */
function reviewTarget() {
  const state = useRepo.getState();
  const { wipSelected, selectedCommits, selectionDiff, graph, stashes, changes, inspectParentIndex } =
    state;
  // Commits + WIP is one range ending at the working tree — the same surface the
  // merged inspector's "review all" opens, not the working-changes view.
  const route = commitDiffRouteFromRepo(state);
  if (route.kind === COMMIT_DIFF_ROUTE.WorkingUnion) {
    const spanned = workingRange(graph, selectionDiff?.commits ?? selectedCommits)?.spanned ?? 0;
    return { kind: COMMIT_DIFF_ROUTE.WorkingUnion, base: route.base, spanned } as const;
  }
  if (route.kind === COMMIT_DIFF_ROUTE.Working) {
    if (wipSelected) return { kind: COMMIT_DIFF_ROUTE.Working } as const;
    const working = changes.staged.length + changes.unstaged.length + changes.conflicted.length;
    return working > 0 ? ({ kind: COMMIT_DIFF_ROUTE.Working } as const) : null;
  }
  if (route.kind === COMMIT_DIFF_ROUTE.Selection)
    return { kind: COMMIT_DIFF_ROUTE.Selection, commits: route.commits } as const;
  const range = inspectParentRangeFromGraph(graph, route.oid, inspectParentIndex);
  const commit = graph?.commits.find((c) => c.id === route.oid);
  const stash = commit ? undefined : stashes.find((s) => s.oid === route.oid);
  const title = commit?.summary ?? stash?.message ?? route.oid.slice(0, 7);
  if (range) return { kind: "inspectRange", base: range.base, head: range.head, title } as const;
  return {
    kind: COMMIT_DIFF_ROUTE.Commit,
    oid: route.oid,
    title,
  } as const;
}

function reviewSelection() {
  const target = reviewTarget();
  const ui = useUi.getState();
  if (!target) return;
  if (target.kind === COMMIT_DIFF_ROUTE.Working) ui.openChangesView(true);
  else if (target.kind === COMMIT_DIFF_ROUTE.WorkingUnion)
    void useRepo.getState().openCompare(workingUnionCompare(target.base, target.spanned));
  else if (target.kind === COMMIT_DIFF_ROUTE.Selection)
    ui.openSelectionReview(target.commits, `Reviewing ${target.commits.length} commits`);
  else if (target.kind === "inspectRange")
    useRepo.getState().compareRange(target.base, target.head, target.title);
  else ui.openStackedReview(target.oid, target.title);
}

function openAiActionsFromSelection() {
  const { selectedCommits, selectedCommit, wipSelected, selectionDiff, changes } =
    useRepo.getState();
  const scope = scopeFromSelection({
    selectedCommits,
    selectedCommit,
    wipSelected,
    workingBase: selectionDiff?.workingBase ?? null,
  });
  if (scope) {
    useUi.getState().openAiActions(scope);
    return;
  }
  const working = changes.staged.length + changes.unstaged.length + changes.conflicted.length;
  if (working > 0) useUi.getState().openAiActions({ kind: AiActionScopeKind.Working });
}

function stepTab(delta: number): boolean {
  const { openPaths, tabInfoByPath } = useRepo.getState();
  // Stepping follows the drawn order, so ⌘⇧] moves to the tab the user sees to
  // the right — inside a group that is its next member, not `openPaths`'s, and
  // never a tab a collapsed group has folded away. The guard counts drawn tabs
  // for the same reason: several open tabs can draw as one.
  const order = visualTabOrder(openPaths, tabInfoByPath, activeTabPath());
  if (order.length < 2) return false;
  const current = order.indexOf(activeTabPath() ?? "");
  if (current < 0) return false;
  return activateTabAt((current + delta + order.length) % order.length);
}

/** The shared listener. A shortcut with no entry in `handlers` is left alone, so
 *  the two dispatchers below can split the registry between them without either
 *  knowing what the other owns. No dependency array: `build` closes over values
 *  that change every render, so the listener is re-bound each time. */
function useShortcutDispatch(build: () => Commands): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // The terminal check comes first: xterm's focused element is a helper
      // <textarea> inside the host, so testing for text entry first would
      // classify every terminal keystroke as typing and the terminal-safe
      // bindings below would never run.
      const terminal = inTerminal(event.target);
      if (!terminal && isTextEntry(event.target)) return;
      if (overlayOpen(useUi.getState())) return;
      const handlers = build();
      for (const shortcut of SHORTCUTS) {
        if (shortcut.kind !== ShortcutKind.Global) continue;
        if (terminal && !TERMINAL_SAFE.includes(shortcut.id)) continue;
        if (!matchesEvent(shortcut, event, isMac)) continue;
        const command = handlers[shortcut.id];
        if (!command) continue;
        if (command.enabled?.() === false) return;
        if (command.run(event) === false) return;
        event.preventDefault();
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
}

/** Window-chrome shortcuts: tab switching and Settings. Mounted in the title bar
 *  because they must survive a tab with no repo — the missing-repo screen has no
 *  toolbar, and switching away from a broken tab is exactly what's needed there.
 *  Store-only, so it needs no view model. */
export function useChromeShortcuts(): void {
  useShortcutDispatch(() => ({
    [ShortcutId.RepoTabByIndex]: {
      run: (event) => {
        const digit = Number(event.code.slice(-1));
        // `mod+9` is "the last tab", so its index comes from the DRAWN order —
        // `openPaths.length - 1` overshoots whenever a collapsed group folds
        // tabs away, and the shortcut silently does nothing.
        const { openPaths, tabInfoByPath } = useRepo.getState();
        const drawn = visualTabOrder(openPaths, tabInfoByPath, activeTabPath()).length;
        return activateTabAt(digit === 9 ? drawn - 1 : digit - 1);
      },
    },
    [ShortcutId.RepoTabPrev]: { run: () => stepTab(-1) },
    [ShortcutId.RepoTabNext]: { run: () => stepTab(1) },

    [ShortcutId.OpenSettings]: { run: () => useUi.getState().openSettings() },
  }));
}

/** Repository shortcuts. Mounted in the toolbar, which only renders with a repo
 *  open — the same condition under which these commands mean anything — so they
 *  can reuse its closures (`runPush` carries the publish-prompt flow). */
export function useShortcuts(model: ActionBarModel): void {
  useShortcutDispatch(() => {
    const ui = useUi.getState;
    const hasChanges = () => model.workCount > 0;
    // The transports mirror their toolbar buttons: a shortcut must not start a
    // push the button refuses (nothing to push, detached, another repo mid-fetch).
    const transportReady = (op: NetOp) =>
      !!model.summary &&
      !model.fetchBlocked &&
      model.busy !== "fetch" &&
      !(model.loading && model.busy !== op);
    return {
      // The keyboard twin of the "‹ Graph" back button: a full route transition
      // out of a review / comparison / file history, not just a tab switch.
      [ShortcutId.BackToGraph]: {
        run: () => useRepo.getState().returnToGraph(),
        // Already on the graph: leave Home to the browser rather than eat it.
        enabled: () => centerView() !== "history",
      },
      [ShortcutId.ViewCommits]: { run: () => model.selectTab("history") },
      [ShortcutId.ViewPulls]: { run: () => model.selectTab("pulls") },
      [ShortcutId.OpenNavigator]: { run: () => ui().openNav() },
      [ShortcutId.ToggleTerminal]: { run: () => model.toggleTerminal() },
      [ShortcutId.Review]: { run: reviewSelection, enabled: () => reviewTarget() !== null },
      [ShortcutId.AiActions]: {
        run: openAiActionsFromSelection,
        enabled: () => reviewTarget() !== null,
      },
      [ShortcutId.Push]: {
        run: () => model.runPush(),
        enabled: () => transportReady("push") && model.currentSync.canPush,
      },
      [ShortcutId.Pull]: {
        run: () => model.runPull(),
        enabled: () => transportReady("pull") && model.currentSync.canPull,
      },
      [ShortcutId.NewBranch]: { run: () => model.openCreateBranch(), enabled: () => !!model.summary },
      [ShortcutId.Stash]: {
        run: () => model.stash(),
        enabled: () => !model.loading && hasChanges(),
      },
    };
  });
}
