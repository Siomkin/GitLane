// The terminal's xterm.js + PTY lifecycle, extracted from TerminalPanel so the
// component stays a presentational shell. Owns the xterm instance, the Rust PTY
// session, theme-following, resize syncing, agent probing, and the queued
// "open in terminal" paste. Returns the handful of values + imperative handles
// the shell needs.

import { useEffect, useRef, useState, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { api, type PtyDataEvent, type PtyExitEvent, type TerminalAgent } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { xtermTheme } from "@/features/terminal/xtermTheme";
import { selectEnabledAgents } from "@/features/terminal/agents";

// Match the rest of the app's monospace (DiffBody's MONO constant) so xterm
// doesn't fall back to its default renderer font.
const MONO_FONT = "ui-monospace, 'SF Mono', Menlo, monospace";

export interface TerminalSession {
  /** Attach to the xterm mount element. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Whether the PTY is currently running. */
  alive: boolean;
  /** Agent targets to render as toolbar buttons. */
  agents: TerminalAgent[];
  /** The shell's working directory (open repo), or null before a repo opens. */
  terminalPath: string | null;
  /** Type an agent command + Enter into the running shell. */
  runAgent: (command: string) => void;
  /** Clear the xterm scrollback. */
  clearTerminal: () => void;
  /** Kill the PTY and hide the terminal. */
  kill: () => Promise<void>;
}

export function useTerminalSession(): TerminalSession {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<number | null>(null);
  // Guards against spawning twice (React StrictMode mounts effects twice in dev).
  const spawnedRef = useRef(false);

  const terminalView = useUi((s) => s.terminalView);
  const terminalExpanded = useUi((s) => s.terminalExpanded);
  const hideTerminal = useUi((s) => s.hideTerminal);
  const theme = useResolvedTheme();
  const summary = useRepo((s) => s.summary);
  const terminalPath = summary?.workdir ?? summary?.path ?? null;
  const agentsRaw = useTerminalAgents((s) => s.agents);
  const loadAgents = useTerminalAgents((s) => s.loadAgents);
  const [alive, setAlive] = useState(false);
  const visible = terminalView !== "hidden";

  // Follow the app's light/dark toggle: re-derive xterm's colors from the CSS
  // variables (the chrome below uses var() directly and adapts on its own).
  useEffect(() => {
    const term = termRef.current;
    const el = containerRef.current;
    if (term && el) term.options.theme = xtermTheme(el);
  }, [theme]);

  // Spawn + wire the PTY once while visible (stays alive across collapse/expand).
  useEffect(() => {
    if (!visible) return;
    if (!containerRef.current || !terminalPath) return;
    if (spawnedRef.current) return;
    spawnedRef.current = true;
    let disposed = false;
    setAlive(false);
    sessionRef.current = null;

    const term = new Terminal({
      fontFamily: MONO_FONT,
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: xtermTheme(containerRef.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* ResizeObserver will retry once layout settles */
    }

    const cols = term.cols;
    const rows = term.rows;
    // Shell output → terminal.
    term.writeln("\x1b[2mStarting shell in " + terminalPath + "…\x1b[0m");
    api
      .ptySpawn(terminalPath, cols, rows)
      .then(({ sessionId }) => {
        if (disposed) return;
        sessionRef.current = sessionId;
        setAlive(true);
      })
      .catch((e) => {
        if (disposed) return;
        setAlive(false);
        term.writeln(
          "\x1b[31mFailed to start terminal: " +
            String(e instanceof Error ? e.message : e) +
            "\x1b[0m",
        );
      });

    // Keystrokes → shell.
    const onDataDisp = term.onData((data) => {
      void api.ptyWrite(new TextEncoder().encode(data)).catch(() => {});
    });

    // Shell output events → terminal.
    const unlistenData = listen<PtyDataEvent>("pty-data", (event) => {
      if (event.payload.sessionId !== sessionRef.current) return;
      term.write(new Uint8Array(event.payload.data));
    });
    const unlistenExit = listen<PtyExitEvent>("pty-exit", (event) => {
      if (event.payload.sessionId !== sessionRef.current) return;
      sessionRef.current = null;
      setAlive(false);
      term.writeln("\r\n\x1b[2m[shell exited]\x1b[0m");
    });

    return () => {
      disposed = true;
      onDataDisp.dispose();
      void unlistenData.then((f) => f());
      void unlistenExit.then((f) => f());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      sessionRef.current = null;
      spawnedRef.current = false;
      void api.ptyKill().catch(() => {});
    };
  }, [terminalPath, visible]);

  // Keep the PTY dimensions in sync with the viewport (debounced). Re-fit when
  // expanding, since the container was hidden while collapsed.
  useEffect(() => {
    if (terminalView === "open") {
      // Refit on expand: the container may have resized while hidden.
      requestAnimationFrame(() => {
        const fit = fitRef.current;
        const term = termRef.current;
        if (!fit || !term) return;
        try {
          fit.fit();
          void api.ptyResize(term.cols, term.rows).catch(() => {});
        } catch {
          /* ignore */
        }
      });
    }
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (terminalView !== "open") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const fit = fitRef.current;
        const term = termRef.current;
        if (!fit || !term) return;
        try {
          fit.fit();
          void api.ptyResize(term.cols, term.rows).catch(() => {});
        } catch {
          /* container hidden — ignore */
        }
      }, 60);
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [terminalExpanded, terminalView]);

  // Load the agent list from the backend config (re-rendered via the store).
  // The store is shared with Settings, so a save there updates the toolbar too.
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const agents = selectEnabledAgents(agentsRaw);

  const runAgent = (command: string) => {
    // Type the agent command + Enter into the running shell.
    void api.ptyWrite(new TextEncoder().encode(`${command}\n`)).catch(() => {});
    termRef.current?.focus();
  };

  // Agent-message flows queue text in the store; paste it once the PTY is alive.
  // Use xterm's paste path instead of writing raw bracketed-paste escape
  // sequences: xterm only brackets when the foreground program has requested
  // bracketed paste mode. When launching an agent first, wait briefly for that
  // prompt to initialize before pasting into it.
  const terminalInject = useUi((s) => s.terminalInject);
  const clearTerminalInject = useUi((s) => s.clearTerminalInject);
  useEffect(() => {
    if (!terminalInject || !alive) return;
    const term = termRef.current;
    if (!term) return;
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
      void api.ptyWrite(encoder.encode(`${terminalInject.command}\n`)).catch(() => {});
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
  }, [terminalInject, alive, clearTerminalInject]);

  const clearTerminal = () => termRef.current?.clear();

  const kill = async () => {
    await api.ptyKill().catch(() => {});
    sessionRef.current = null;
    setAlive(false);
    hideTerminal();
  };

  return { containerRef, alive, agents, terminalPath, runAgent, clearTerminal, kill };
}
