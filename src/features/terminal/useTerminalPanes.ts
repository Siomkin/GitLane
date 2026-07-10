// The xterm.js + PTY lifecycle for the integrated terminal, now multi-pane.
//
// Each terminal tab (see `store/terminals.ts`) owns one live xterm instance and
// one Rust PTY session. Every pane stays mounted for the whole app session — its
// DOM element lives inside the always-mounted drawer and is only hidden (CSS)
// when it isn't the active repo's active tab. So switching repos or tabs just
// toggles visibility; nothing is disposed and no scrollback is lost. A PTY dies
// only when the user closes that tab (via `store/terminals` → this hook) or the
// shell itself exits.
//
// This hook is the React half: it reconciles the live panes against the
// declarative tab state and exposes handles bound to the *active* pane. The
// pane bookkeeping itself — creation/disposal, event routing, and the single
// failure-surfacing write path — lives in `paneController.ts` (GL-176), which
// this hook feeds with real xterm/DOM/api adapters.

import { useEffect, useReducer, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { api, type PtyDataEvent, type PtyExitEvent, type TerminalAgent } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useTerminals } from "@/store/terminals";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { xtermTheme } from "@/features/terminal/xtermTheme";
import { selectEnabledAgents } from "@/features/terminal/agents";
import { MONO_FONT } from "@/lib/ui";
import { PaneController, type Pane, type PaneView } from "./paneController";

export interface TerminalPanes {
  /** Attach to the shared host element that holds every pane's mount div. */
  hostRef: RefObject<HTMLDivElement | null>;
  /** Whether the *active* tab's PTY is running (drives the status dot). */
  alive: boolean;
  /** Agent targets to render as toolbar buttons. */
  agents: TerminalAgent[];
  /** The active repo's identity path (the tab-store key + collapsed-pill label),
   *  or null before a repo opens. */
  terminalPath: string | null;
  /** Type an agent command + Enter into the active tab's shell. */
  runAgent: (command: string) => void;
  /** Clear the active tab's scrollback. */
  clearTerminal: () => void;
}

export function useTerminalPanes(): TerminalPanes {
  const hostRef = useRef<HTMLDivElement>(null);
  // Bump to re-render when a pane's `alive` flips (spawn resolved / shell exited)
  // — the panes live in the controller, so React needs a nudge to re-read them.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  // One controller for the app session. Its view factory builds the real
  // xterm + mount element under the shared host; its io adapter is the PTY IPC.
  const controllerRef = useRef<PaneController | null>(null);
  if (!controllerRef.current) {
    const createView = (_cwd: string): PaneView => {
      const host = hostRef.current;
      if (!host) throw new Error("terminal host not mounted");
      const el = document.createElement("div");
      el.style.position = "absolute";
      el.style.inset = "0";
      host.appendChild(el);

      const term = new Terminal({
        fontFamily: MONO_FONT,
        fontSize: 12,
        lineHeight: 1.25,
        cursorBlink: true,
        scrollback: 5000,
        theme: xtermTheme(el),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      try {
        fit.fit();
      } catch {
        /* container hidden — the resize observer re-fits once it has layout */
      }
      return {
        term,
        el,
        fit: () => fit.fit(),
        applyTheme: () => {
          term.options.theme = xtermTheme(el);
        },
        paste: (text) => term.paste(text),
        bracketedPaste: () => term.modes.bracketedPasteMode,
        clear: () => term.clear(),
      };
    };
    controllerRef.current = new PaneController(
      {
        spawn: (spawnCwd, cols, rows) => api.ptySpawn(spawnCwd, cols, rows),
        write: (sessionId, data) => api.ptyWrite(sessionId, data),
        kill: (sessionId) => api.ptyKill(sessionId),
      },
      createView,
      forceRender,
    );
  }
  const controller = controllerRef.current;

  const terminalView = useUi((s) => s.terminalView);
  const terminalExpanded = useUi((s) => s.terminalExpanded);
  const theme = useResolvedTheme();
  const summary = useRepo((s) => s.summary);
  // Terminal identity = the repo's open path (matches `openPaths` and the tab
  // store key, so `closeRepoTerminals` lines up); the shell's working directory
  // is `workdir` (falling back to path). Tabs/panes key by identity, shells spawn
  // in the working dir.
  const repoKey = summary?.path ?? null;
  const cwd = summary?.workdir ?? summary?.path ?? null;

  const byRepo = useTerminals((s) => s.byRepo);
  const ensureTab = useTerminals((s) => s.ensureTab);
  const agentsRaw = useTerminalAgents((s) => s.agents);
  const loadAgents = useTerminalAgents((s) => s.loadAgents);

  const activeTabId = repoKey ? (byRepo[repoKey]?.activeId ?? null) : null;
  const activePane = activeTabId ? (controller.get(activeTabId) ?? null) : null;
  const alive = activePane?.alive ?? false;

  // A stable signature of every tab that should have a live pane, across all
  // repos — the reconcile effect re-runs whenever a tab is added or removed.
  const tabSignature = Object.entries(byRepo)
    .flatMap(([key, r]) => r.tabs.map((t) => `${key} ${t.id}`))
    .join("|");

  // ── Shared PTY event routing (mounted once) ──────────────────────────────
  useEffect(() => {
    const unlistenData = listen<PtyDataEvent>("pty-data", (event) => {
      controller.routeData(event.payload.sessionId, event.payload.data);
    });
    const unlistenExit = listen<PtyExitEvent>("pty-exit", (event) => {
      controller.routeExit(event.payload.sessionId);
    });
    return () => {
      void unlistenData.then((f) => f());
      void unlistenExit.then((f) => f());
    };
  }, [controller]);

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
      if (controller.get(tabId) || key !== repoKey) continue;
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
    if (activeTabId) refit(controller.get(activeTabId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabSignature, activeTabId, repoKey, cwd, terminalView, terminalExpanded]);

  // ── Re-fit the active pane when the drawer resizes ───────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (terminalView !== "open") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (activeTabId) refit(controller.get(activeTabId));
      }, 60);
    });
    ro.observe(host);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [terminalView, terminalExpanded, activeTabId, controller]);

  // ── Follow the app's light/dark theme across every pane ──────────────────
  useEffect(() => {
    for (const pane of controller.panes.values()) {
      pane.view.applyTheme();
    }
  }, [theme, controller]);

  // ── Agents (shared with Settings) ────────────────────────────────────────
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);
  const agents = selectEnabledAgents(agentsRaw);

  const runAgent = (command: string) => {
    if (!activeTabId) return;
    // The controller surfaces a dead pane or a failed write in the terminal
    // itself (GL-176) — the command must never look accepted when it wasn't.
    void controller.write(activeTabId, new TextEncoder().encode(`${command}\n`));
    controller.get(activeTabId)?.view.term.focus();
  };

  const clearTerminal = () => {
    if (activeTabId) controller.get(activeTabId)?.view.clear();
  };

  // ── "Open in terminal" paste queue → the active pane ─────────────────────
  // Use xterm's paste path (it only brackets when the foreground program has
  // requested bracketed-paste mode). When launching an agent first, wait for its
  // prompt to initialize before pasting into it.
  const terminalInject = useUi((s) => s.terminalInject);
  const clearTerminalInject = useUi((s) => s.clearTerminalInject);
  useEffect(() => {
    if (!terminalInject) return;
    // An injection belongs to the repo whose flow queued it: if another repo is
    // active by the time it could deliver (queued while dead, repo switched
    // after a failed launch, …), discard it rather than pasting into a
    // different repo's shell (GL-176 review). Runs before the alive gate so a
    // stale injection dies immediately, not on the next repo's spawn.
    if (terminalInject.repoKey !== repoKey) {
      clearTerminalInject();
      return;
    }
    if (!alive || !activeTabId) return;
    const pane = controller.get(activeTabId);
    if (!pane || pane.sessionId == null) return;
    const { view } = pane;
    let cancelled = false;
    let timer: number | undefined;
    const paste = () => {
      if (cancelled) return;
      view.paste(terminalInject.text);
      view.term.focus();
      clearTerminalInject();
    };
    if (terminalInject.command) {
      void controller.write(activeTabId, new TextEncoder().encode(`${terminalInject.command}\n`)).then((ok) => {
        if (cancelled) return;
        // The launch write failed (surfaced in the terminal) — keep the
        // injection queued instead of dropping the text on the floor (GL-176).
        if (!ok) return;
        const startedAt = Date.now();
        const waitForPrompt = () => {
          if (cancelled) return;
          if (view.bracketedPaste() || Date.now() - startedAt > 4000) {
            paste();
            return;
          }
          timer = window.setTimeout(waitForPrompt, 100);
        };
        timer = window.setTimeout(waitForPrompt, 500);
      });
    } else {
      paste();
    }
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [terminalInject, alive, activeTabId, clearTerminalInject, controller, repoKey]);

  return { hostRef, alive, agents, terminalPath: repoKey, runAgent, clearTerminal };

  // ── Fit + PTY resize for one pane (called with layout settled) ────────────
  function refit(pane: Pane | undefined) {
    if (!pane) return;
    requestAnimationFrame(() => {
      try {
        pane.view.fit();
        if (pane.sessionId != null) {
          // Resize failures are non-input noise (they race normal shell exits);
          // they don't go through the surfaced write path deliberately.
          void api.ptyResize(pane.sessionId, pane.view.term.cols, pane.view.term.rows).catch(() => {});
        }
      } catch {
        /* container hidden — ignore */
      }
    });
  }
}
