// The in-app integrated terminal: an xterm.js emulator wired to a Rust PTY.
//
// One persistent PTY runs the user's login shell with cwd = the open repo.
// Output streams back via the `pty-data` Tauri event; keystrokes go out through
// `ptyWrite`. Agent buttons (opencode/kimi/claude/codex) just type their command into
// the running shell — they're not separate processes, so the user keeps full
// interactive control and the agent inherits the repo's environment.
//
// Rendered as a floating popup at the bottom of the window. It collapses to a
// small status pill without unmounting (the PTY and its scrollback keep
// running); only the close button kills the PTY.
//
// This file is the presentational shell only — the xterm/PTY lifecycle lives in
// `hooks/useTerminalSession`.

import { cn } from "@/lib/cn";
import { useUi } from "@/store/ui";
import { useTerminalSession } from "@/hooks/useTerminalSession";
import { ClearIcon, CloseIcon, CollapseIcon, ExpandIcon, RestoreIcon } from "./terminalIcons";

/**
 * The terminal layer. Rendered once in App; never unmounts while the terminal
 * is non-hidden, so the xterm instance + PTY survive collapse/expand.
 */
export function TerminalLayer() {
  const terminalView = useUi((s) => s.terminalView);
  const terminalHeight = useUi((s) => s.terminalHeight);
  const terminalExpanded = useUi((s) => s.terminalExpanded);
  const adjustTerminalHeight = useUi((s) => s.adjustTerminalHeight);
  const collapseTerminal = useUi((s) => s.collapseTerminal);
  const expandTerminal = useUi((s) => s.expandTerminal);
  const toggleTerminalExpanded = useUi((s) => s.toggleTerminalExpanded);

  const { containerRef, alive, agents, terminalPath, runAgent, clearTerminal, kill } =
    useTerminalSession();

  if (terminalView === "hidden") return null;

  return (
    <>
      {/* Open drawer. Kept mounted (just visually hidden) while collapsed so the
          xterm instance + PTY survive the collapse/expand cycle. */}
      <div
        aria-hidden={terminalView === "collapsed"}
        className={cn(
          "absolute left-2.5 right-2.5 bottom-2.5 z-[45] flex min-w-0 flex-col overflow-hidden rounded-xl border border-black/10 bg-white shadow-[0_-12px_44px_-12px_rgba(0,0,0,0.35)] transition duration-150 dark:border-white/10 dark:bg-neutral-900",
          terminalView === "collapsed" &&
            "pointer-events-none translate-y-3 scale-[0.98] opacity-0",
        )}
        style={{ height: terminalExpanded ? "calc(100% - 20px)" : terminalHeight }}
      >
        {/* Top drag handle, wired to the existing height-adjust logic. */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            let lastY = e.clientY;
            const move = (ev: MouseEvent) => {
              adjustTerminalHeight(lastY - ev.clientY);
              lastY = ev.clientY;
            };
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
              document.body.style.cursor = "";
              document.body.style.userSelect = "";
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
            document.body.style.cursor = "ns-resize";
            document.body.style.userSelect = "none";
          }}
          title="Drag to resize"
          className="absolute inset-x-0 top-0 z-10 h-2 cursor-ns-resize"
        />

        {/* Header bar. */}
        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-black/5 bg-black/[0.03] px-3 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
              Terminal
            </span>
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                alive ? "bg-emerald-500" : "bg-neutral-400",
              )}
            />
          </div>
          <div className="h-4 w-px bg-black/10 dark:bg-white/10" />
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => runAgent(agent.command)}
              disabled={!agent.available || !alive}
              title={agent.available ? agent.description : "Not installed"}
              className="rounded-md px-2 py-1 font-mono text-[11px] text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {agent.name}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-0.5 text-neutral-400">
            <button
              onClick={clearTerminal}
              title="Clear terminal"
              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
            >
              <ClearIcon />
            </button>
            <button
              onClick={toggleTerminalExpanded}
              title={terminalExpanded ? "Restore terminal size" : "Maximize terminal"}
              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
            >
              {terminalExpanded ? <RestoreIcon /> : <ExpandIcon />}
            </button>
            <button
              onClick={collapseTerminal}
              title="Collapse"
              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
            >
              <CollapseIcon />
            </button>
            <button
              onClick={kill}
              title="Close terminal"
              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* xterm mount — kept exactly as before, just wrapped to flex the body. */}
        <div ref={containerRef} className="min-h-0 flex-1 bg-[var(--code)] px-3 py-2" />
      </div>

      {terminalView === "collapsed" && (
        <button
          onClick={expandTerminal}
          title="Expand terminal"
          className="absolute bottom-2.5 left-2.5 z-[52] flex h-11 items-center gap-2.5 rounded-xl border border-black/10 bg-white pl-3 pr-4 shadow-[0_14px_36px_-6px_rgba(0,0,0,0.42)] hover:bg-neutral-50 dark:border-white/10 dark:bg-neutral-800 dark:hover:bg-neutral-700"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 text-neutral-400"
            aria-hidden="true"
          >
            <path d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7" />
          </svg>
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              alive ? "bg-emerald-500" : "bg-neutral-400",
            )}
          />
          <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
            {alive ? "Terminal running" : "Terminal idle"}
          </span>
          <span className="max-w-[280px] truncate font-mono text-[12px] text-neutral-400">
            {terminalPath}
          </span>
        </button>
      )}
    </>
  );
}
