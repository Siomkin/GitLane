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
// This hook is the imperative half: it reconciles the live panes against the
// declarative tab state, routes the shared `pty-data`/`pty-exit` events to the
// right pane by session id, and exposes handles bound to the *active* pane.

import { useEffect, useReducer, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import type { IDisposable } from "@xterm/xterm";
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

/** One live terminal pane: an xterm instance bound to a Rust PTY session. */
interface Pane {
  term: Terminal;
  fit: FitAddon;
  /** The Rust PTY session id, or null before spawn resolves / after exit. */
  sessionId: number | null;
  /** The pane's own mount element, an absolute child of the shared host. */
  el: HTMLDivElement;
  /** The shell's working directory (the repo's `workdir`). */
  cwd: string;
  alive: boolean;
  onData: IDisposable | null;
}

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
  const panesRef = useRef<Map<string, Pane>>(new Map());
  const bySessionRef = useRef<Map<number, string>>(new Map());
  // Bump to re-render when a pane's `alive` flips (spawn resolved / shell exited)
  // — the panes live in refs, so React needs a nudge to re-read them.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

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
  const activePane = activeTabId ? (panesRef.current.get(activeTabId) ?? null) : null;
  const alive = activePane?.alive ?? false;

  // A stable signature of every tab that should have a live pane, across all
  // repos — the reconcile effect re-runs whenever a tab is added or removed.
  const tabSignature = Object.entries(byRepo)
    .flatMap(([key, r]) => r.tabs.map((t) => `${key} ${t.id}`))
    .join("|");

  // ── Shared PTY event routing (mounted once) ──────────────────────────────
  useEffect(() => {
    const panes = panesRef.current;
    const bySession = bySessionRef.current;
    const unlistenData = listen<PtyDataEvent>("pty-data", (event) => {
      const tabId = bySession.get(event.payload.sessionId);
      if (!tabId) return;
      panes.get(tabId)?.term.write(new Uint8Array(event.payload.data));
    });
    const unlistenExit = listen<PtyExitEvent>("pty-exit", (event) => {
      const tabId = bySession.get(event.payload.sessionId);
      if (!tabId) return;
      bySession.delete(event.payload.sessionId);
      const pane = panes.get(tabId);
      if (!pane) return;
      pane.sessionId = null;
      pane.alive = false;
      pane.term.writeln("\r\n\x1b[2m[shell exited]\x1b[0m");
      forceRender();
    });
    return () => {
      void unlistenData.then((f) => f());
      void unlistenExit.then((f) => f());
    };
  }, []);

  // ── Dispose every pane's xterm + PTY when the layer unmounts ──────────────
  // App hoists TerminalLayer out of the repo-summary gate, so it stays mounted
  // across repo open/close/switch — this cleanup only fires on true app teardown
  // (or an HMR remount in dev). Defensive net so no shell is ever orphaned; live
  // per-repo disposal on a repo close goes through `closeRepoTerminals` +
  // reconcile instead. Runs once.
  useEffect(() => {
    const panes = panesRef.current;
    const bySession = bySessionRef.current;
    return () => {
      for (const tabId of [...panes.keys()]) disposePane(tabId, panes, bySession);
    };
  }, []);

  // ── Ensure the active repo always has a tab while the drawer is open ──────
  useEffect(() => {
    if (terminalView === "open" && repoKey) ensureTab(repoKey);
  }, [terminalView, repoKey, ensureTab]);

  // ── Reconcile live panes against the tab state ───────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const panes = panesRef.current;
    const bySession = bySessionRef.current;

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
      if (panes.has(tabId) || key !== repoKey) continue;
      createPane(tabId, cwd ?? key, host, panes, bySession, forceRender);
    }
    // Dispose panes whose tab left the store (tab closed, or its repo closed).
    for (const tabId of [...panes.keys()]) {
      if (!wanted.has(tabId)) disposePane(tabId, panes, bySession);
    }
    // Show the active pane, hide the rest; re-fit the one now visible.
    for (const [tabId, pane] of panes) {
      pane.el.style.display = tabId === activeTabId ? "block" : "none";
    }
    if (activeTabId) refit(panes.get(activeTabId));
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
        if (activeTabId) refit(panesRef.current.get(activeTabId));
      }, 60);
    });
    ro.observe(host);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [terminalView, terminalExpanded, activeTabId]);

  // ── Follow the app's light/dark theme across every pane ──────────────────
  useEffect(() => {
    for (const pane of panesRef.current.values()) {
      pane.term.options.theme = xtermTheme(pane.el);
    }
  }, [theme]);

  // ── Agents (shared with Settings) ────────────────────────────────────────
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);
  const agents = selectEnabledAgents(agentsRaw);

  const runAgent = (command: string) => {
    const pane = activeTabId ? panesRef.current.get(activeTabId) : null;
    if (!pane || pane.sessionId == null) return;
    void api.ptyWrite(pane.sessionId, new TextEncoder().encode(`${command}\n`)).catch(() => {});
    pane.term.focus();
  };

  const clearTerminal = () => {
    if (activeTabId) panesRef.current.get(activeTabId)?.term.clear();
  };

  // ── "Open in terminal" paste queue → the active pane ─────────────────────
  // Use xterm's paste path (it only brackets when the foreground program has
  // requested bracketed-paste mode). When launching an agent first, wait for its
  // prompt to initialize before pasting into it.
  const terminalInject = useUi((s) => s.terminalInject);
  const clearTerminalInject = useUi((s) => s.clearTerminalInject);
  useEffect(() => {
    if (!terminalInject || !alive) return;
    const pane = activeTabId ? panesRef.current.get(activeTabId) : null;
    if (!pane || pane.sessionId == null) return;
    const { term, sessionId } = pane;
    const encoder = new TextEncoder();
    let cancelled = false;
    let timer: number | undefined;
    const paste = () => {
      if (cancelled) return;
      term.paste(terminalInject.text);
      term.focus();
      clearTerminalInject();
    };
    if (terminalInject.command) {
      void api.ptyWrite(sessionId, encoder.encode(`${terminalInject.command}\n`)).catch(() => {});
      const startedAt = Date.now();
      const waitForPrompt = () => {
        if (cancelled) return;
        if (term.modes.bracketedPasteMode || Date.now() - startedAt > 4000) {
          paste();
          return;
        }
        timer = window.setTimeout(waitForPrompt, 100);
      };
      timer = window.setTimeout(waitForPrompt, 500);
    } else {
      paste();
    }
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [terminalInject, alive, activeTabId, clearTerminalInject]);

  return { hostRef, alive, agents, terminalPath: repoKey, runAgent, clearTerminal };
}

// ── Pure-ish pane helpers (module scope: no React state, only the ref maps) ──

function createPane(
  tabId: string,
  cwd: string,
  host: HTMLDivElement,
  panes: Map<string, Pane>,
  bySession: Map<number, string>,
  forceRender: () => void,
) {
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

  const pane: Pane = { term, fit, sessionId: null, el, cwd, alive: false, onData: null };
  panes.set(tabId, pane);

  pane.onData = term.onData((data) => {
    if (pane.sessionId == null) return;
    void api.ptyWrite(pane.sessionId, new TextEncoder().encode(data)).catch(() => {});
  });

  term.writeln("\x1b[2mStarting shell in " + cwd + "…\x1b[0m");
  api
    .ptySpawn(cwd, term.cols || 80, term.rows || 24)
    .then(({ sessionId }) => {
      // Guard by pane IDENTITY, not tabId presence: a fast unmount→remount (or
      // StrictMode's double-mount) can dispose this pane and create a new one
      // under the same tabId before this spawn resolves. Adopting the session
      // into the wrong (or a gone) pane would orphan a PTY and cross-wire its
      // output — so kill it instead.
      if (panes.get(tabId) !== pane) {
        void api.ptyKill(sessionId).catch(() => {});
        return;
      }
      pane.sessionId = sessionId;
      pane.alive = true;
      bySession.set(sessionId, tabId);
      forceRender();
    })
    .catch((e) => {
      term.writeln(
        "\x1b[31mFailed to start terminal: " +
          String(e instanceof Error ? e.message : e) +
          "\x1b[0m",
      );
    });
}

function disposePane(
  tabId: string,
  panes: Map<string, Pane>,
  bySession: Map<number, string>,
) {
  const pane = panes.get(tabId);
  if (!pane) return;
  pane.onData?.dispose();
  if (pane.sessionId != null) {
    bySession.delete(pane.sessionId);
    void api.ptyKill(pane.sessionId).catch(() => {});
  }
  pane.term.dispose();
  pane.el.remove();
  panes.delete(tabId);
}

function refit(pane: Pane | undefined) {
  if (!pane) return;
  requestAnimationFrame(() => {
    try {
      pane.fit.fit();
      if (pane.sessionId != null) {
        void api.ptyResize(pane.sessionId, pane.term.cols, pane.term.rows).catch(() => {});
      }
    } catch {
      /* container hidden — ignore */
    }
  });
}
