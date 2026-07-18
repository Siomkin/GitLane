// Pane reconciliation (GL-177): keeps the controller's live panes in sync with
// the declarative tab state — create panes for the active repo's new tabs,
// dispose panes whose tab left the store, toggle visibility, and re-fit on
// drawer/theme changes. Panes are never remounted for a repo/tab switch, only
// hidden, so scrollback survives. Every input is explicit and every effect
// lists its full dependencies (reconciliation is idempotent, so the extra
// re-runs a broad `byRepo` dependency allows are harmless) — no
// exhaustive-deps suppression.

import { useEffect, type RefObject } from "react";
import type { TermTab } from "@/store/terminals";
import type { PaneController } from "./paneController";

export interface PaneReconcilerInputs {
  controller: PaneController;
  /** The shared host element that holds every pane's mount div. */
  hostRef: RefObject<HTMLDivElement | null>;
  /** Declarative tab state across all repos (`store/terminals`). */
  byRepo: Record<string, { tabs: TermTab[] }>;
  activeTabId: string | null;
  /** The active repo's identity path (the tab-store key), or null. */
  repoKey: string | null;
  /** The active repo's working directory — where new shells spawn. */
  cwd: string | null;
  terminalView: "hidden" | "collapsed" | "open";
  terminalExpanded: boolean;
  theme: "dark" | "light";
  /** Both PTY event subscriptions are installed. New shells must not spawn
   * before this becomes true or their initial output can be lost. */
  ptyEventsReady: boolean;
  /** Ensure `repoKey` has at least one tab (store action, stable). */
  ensureTab: (repoKey: string) => string;
}

export function usePaneReconciler({
  controller,
  hostRef,
  byRepo,
  activeTabId,
  repoKey,
  cwd,
  terminalView,
  terminalExpanded,
  theme,
  ptyEventsReady,
  ensureTab,
}: PaneReconcilerInputs): void {
  // ── Dispose every pane's xterm + PTY when the layer unmounts ──────────────
  // App hoists TerminalLayer out of the repo-summary gate, so it stays mounted
  // across repo open/close/switch — this cleanup only fires on true app teardown
  // (or an HMR remount in dev). Defensive net so no shell is ever orphaned; live
  // per-repo disposal on a repo close goes through `closeRepoTerminals` +
  // reconcile instead. Runs once.
  useEffect(() => {
    return () => controller.disposeAll();
  }, [controller]);

  // ── Ensure the active repo always has a tab while the drawer is open ──────
  useEffect(() => {
    if (terminalView === "open" && repoKey) ensureTab(repoKey);
  }, [terminalView, repoKey, ensureTab]);

  // ── Reconcile live panes against the tab state ───────────────────────────
  // (`terminalView`/`terminalExpanded` are deliberate extra deps: opening or
  // resizing the drawer must re-fit the now-visible active pane.)
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Which tabs should have a pane (tabId -> owning repo identity key).
    const wanted = new Map<string, string>();
    for (const [key, r] of Object.entries(byRepo)) {
      for (const t of r.tabs) wanted.set(t.id, key);
    }

    // Create a pane only for the ACTIVE repo's new tabs. Tabs are only ever
    // added to the active repo, so a tab from another repo that has no pane is
    // stale metadata (e.g. a repo closed while the layer was unmounted) — never
    // resurrect it into a stray background shell. Existing background panes are
    // kept (disposed below only when their tab actually leaves the store). The
    // shell spawns in the active repo's working dir (`cwd`).
    for (const [tabId, key] of wanted) {
      if (!ptyEventsReady || controller.get(tabId) || key !== repoKey) continue;
      controller.create(tabId, cwd ?? key);
    }
    // Dispose panes whose tab left the store (tab closed, or its repo closed).
    for (const tabId of [...controller.panes.keys()]) {
      if (!wanted.has(tabId)) controller.dispose(tabId);
    }
    // Show the active pane, hide the rest; re-fit the one now visible.
    for (const [tabId, pane] of controller.panes) {
      pane.view.el.style.display = tabId === activeTabId ? "block" : "none";
    }
    if (activeTabId) controller.refit(activeTabId);
  }, [
    controller,
    hostRef,
    byRepo,
    activeTabId,
    repoKey,
    cwd,
    terminalView,
    terminalExpanded,
    ptyEventsReady,
  ]);

  // ── Re-fit the active pane when the drawer resizes ───────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (terminalView !== "open") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (activeTabId) controller.refit(activeTabId);
      }, 60);
    });
    ro.observe(host);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [controller, hostRef, terminalView, terminalExpanded, activeTabId]);

  // ── Follow the app's light/dark theme across every pane ──────────────────
  useEffect(() => {
    for (const pane of controller.panes.values()) {
      pane.view.applyTheme();
    }
  }, [theme, controller]);
}
