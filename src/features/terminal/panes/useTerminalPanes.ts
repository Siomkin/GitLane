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
// This hook is the facade (GL-177): it builds the pane controller with real
// xterm/DOM/api adapters, reads the stores, and composes the pieces that each
// change for their own reason — `usePtyEvents` (event transport),
// `usePaneReconciler` (panes ↔ tab state), and `useTerminalInjection` (the
// "open in terminal" paste queue). The pane bookkeeping itself — creation and
// disposal, event routing, refit, and the single failure-surfacing write path —
// lives in `paneController.ts` (GL-176). This file is the documented `api`
// boundary for the terminal feature (eslint.config.js); the sub-hooks never
// touch `api` directly.

import { useEffect, useReducer, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, type TerminalAgent } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useTerminals } from "@/store/terminals";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { xtermTheme } from "@/features/terminal/xtermTheme";
import { selectEnabledAgents } from "@/features/terminal/agents";
import { shellQuotePaths } from "@/features/terminal/dropPaths";
import { pathsFromUriList } from "@/lib/paths";
import { MONO_FONT } from "@/lib/ui";
import { PaneController, type PaneView } from "./paneController";
import { usePtyEvents } from "./usePtyEvents";
import { usePaneReconciler } from "./usePaneReconciler";
import { useTerminalInjection } from "./useTerminalInjection";

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

      // Drop a file from the OS file manager to paste its shell-quoted path,
      // matching GNOME/macOS Terminal. The WebView delivers the drag as normal
      // HTML5 DnD (Tauri's `dragDropEnabled` is false), so the `file://` URIs
      // arrive in `text/uri-list`. Pasting routes through xterm's normal input
      // path (term.onData → PTY), honouring bracketed paste.
      el.addEventListener("dragover", (e) => {
        const dt = e.dataTransfer;
        if (!dt || !dt.types.includes("Files")) return;
        e.preventDefault();
        dt.dropEffect = "copy";
      });
      el.addEventListener("drop", (e) => {
        const dt = e.dataTransfer;
        if (!dt) return;
        const paths = pathsFromUriList(dt.getData("text/uri-list"));
        if (paths.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        term.paste(shellQuotePaths(paths));
        term.focus();
      });
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
        // Resize failures are non-input noise (they race normal shell exits);
        // the controller swallows them deliberately (see `refit`).
        resize: (sessionId, cols, rows) => api.ptyResize(sessionId, cols, rows),
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

  usePtyEvents(controller);
  usePaneReconciler({
    controller,
    hostRef,
    byRepo,
    activeTabId,
    repoKey,
    cwd,
    terminalView,
    terminalExpanded,
    theme,
    ensureTab,
  });

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

  useTerminalInjection({ controller, activeTabId, alive, repoKey });

  return { hostRef, alive, agents, terminalPath: repoKey, runAgent, clearTerminal };
}
