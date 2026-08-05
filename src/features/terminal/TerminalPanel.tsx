// The in-app integrated terminal: xterm.js emulators wired to Rust PTYs.
//
// Each terminal tab runs its own PTY (the user's login shell, cwd = a repo), and
// tabs are kept per repo — switching repos or tabs just shows a different live
// pane, so no shell or scrollback is ever reset. Output streams back via the
// `pty-data` Tauri event; keystrokes go out through `ptyWrite`. Agent buttons
// (opencode/kimi/claude/codex) type their command into the active tab's shell —
// they're not separate processes, so the user keeps full interactive control and
// the agent inherits the repo's environment.
//
// Rendered as a floating popup at the bottom of the window. App keeps the layer
// mounted for the whole app session — across repo open/close/switch and
// hide/collapse (just visually gone) — so every pane's PTY + scrollback survive;
// `useTerminalPanes` disposes every pane only on true app teardown. A PTY dies
// when the user closes its tab, its repo's tabs are dropped (`closeRepoTerminals`
// + reconcile), or the shell exits. The tab strip lives in `TerminalTabs`, the
// xterm/PTY lifecycle in `useTerminalPanes`.

import { useRef } from "react";
import { cn } from "@/lib/cn";
import { useUi } from "@/store/ui";
import { useTerminalPanes } from "@/features/terminal/panes";
import { TerminalTabs } from "./TerminalTabs";
import { TerminalResizeHandles } from "./TerminalResizeHandles";
import { TERMINAL_EDGE_MARGIN } from "./terminalPanelGeometry";
import { ClearIcon, CloseIcon, CollapseIcon, ExpandIcon, RestoreIcon } from "./terminalIcons";

/**
 * The terminal layer. Stays mounted across repo/tab switches and
 * hide/collapse/expand so every pane's xterm instance + PTY survive; it unmounts
 * only when no repo is open, and the panes manager disposes the PTYs then.
 */
export function TerminalLayer() {
  const terminalView = useUi((s) => s.terminalView);
  const terminalHeight = useUi((s) => s.terminalHeight);
  const terminalBottomInset = useUi((s) => s.terminalBottomInset);
  const terminalHorizontalLayout = useUi((s) => s.terminalHorizontalLayout);
  const terminalExpanded = useUi((s) => s.terminalExpanded);
  const adjustTerminalHeight = useUi((s) => s.adjustTerminalHeight);
  const setTerminalVertical = useUi((s) => s.setTerminalVertical);
  const setTerminalHorizontalInsets = useUi((s) => s.setTerminalHorizontalInsets);
  const collapseTerminal = useUi((s) => s.collapseTerminal);
  const expandTerminal = useUi((s) => s.expandTerminal);
  const toggleTerminalExpanded = useUi((s) => s.toggleTerminalExpanded);
  const hideTerminal = useUi((s) => s.hideTerminal);

  const { hostRef, alive, agents, terminalPath, runAgent, clearTerminal } = useTerminalPanes();
  const panelRef = useRef<HTMLDivElement>(null);

  // The layer is always mounted (App hoists it out of the repo-summary gate so
  // panes survive repo switches), so hide the drawer itself when there's no repo
  // open — otherwise an empty panel would show over the welcome screen and flash
  // during closeRepo's transient null summary. The host stays mounted (just
  // display:none) so panes are never disposed.
  const visible = terminalView !== "hidden" && !!terminalPath;

  // A bottom corner only needs the backdrop's square treatment when it sits at
  // the workspace edge — that's where it lands exactly on a workspace block's
  // corner and the block's border/shadow arc shows in the rounded notch. An
  // interior corner (a side away from the edge, or the panel lifted off the
  // floor) floats over block content, where a square grey corner would itself
  // be the artifact. So both the side AND the bottom must be edge-aligned.
  const bottomAtEdge = terminalExpanded || terminalBottomInset <= TERMINAL_EDGE_MARGIN;
  const leftAtEdge =
    bottomAtEdge &&
    (terminalExpanded ||
      Math.max(TERMINAL_EDGE_MARGIN, terminalHorizontalLayout?.leftInset ?? TERMINAL_EDGE_MARGIN) ===
        TERMINAL_EDGE_MARGIN);
  const rightAtEdge =
    bottomAtEdge &&
    (terminalExpanded ||
      (terminalHorizontalLayout
        ? Math.max(TERMINAL_EDGE_MARGIN, terminalHorizontalLayout.rightInset) ===
          TERMINAL_EDGE_MARGIN
        : false));

  // Shared by the drawer and its backdrop so the two always coincide.
  const frameStyle = {
    height: terminalExpanded
      ? `calc(100% - ${TERMINAL_EDGE_MARGIN * 2}px)`
      : terminalHeight,
    bottom: terminalExpanded
      ? TERMINAL_EDGE_MARGIN
      : Math.max(TERMINAL_EDGE_MARGIN, terminalBottomInset),
    left: terminalExpanded
      ? TERMINAL_EDGE_MARGIN
      : Math.max(
          TERMINAL_EDGE_MARGIN,
          terminalHorizontalLayout?.leftInset ?? TERMINAL_EDGE_MARGIN,
        ),
    right:
      terminalExpanded
        ? TERMINAL_EDGE_MARGIN
        : terminalHorizontalLayout
          ? Math.max(TERMINAL_EDGE_MARGIN, terminalHorizontalLayout.rightInset)
          : `calc(50% - ${TERMINAL_EDGE_MARGIN}px)`,
  };

  return (
    <>
      {/* App-background backdrop. Where a bottom corner sits at the workspace
          edge it stays square, filling the drawer's rounded-corner notch with
          the gap colour so the workspace block's border/shadow arc underneath
          can't show as a dark hairline. Everywhere else (top corners, interior
          bottom corners) it matches the drawer's radius and stays invisible. */}
      <div
        aria-hidden
        className={cn(
          // Mirrors the drawer's collapse transition so the two fade/slide as
          // one — an instant show/hide here would flash a gap-coloured slab on
          // expand and let the hairline reappear mid-collapse.
          // The colours duplicate gp-root's shell background (App.tsx); keep
          // them in sync if the app background ever changes.
          // `transform-gpu` for the same compositing reason as the drawer below.
          "pointer-events-none absolute z-[44] transform-gpu rounded-t-xl bg-neutral-100 transition-[opacity,transform] duration-150 dark:bg-neutral-900",
          leftAtEdge ? "rounded-bl-none" : "rounded-bl-xl",
          rightAtEdge ? "rounded-br-none" : "rounded-br-xl",
          !visible && "hidden",
          visible &&
            terminalView === "collapsed" &&
            "translate-y-3 scale-[0.98] opacity-0",
        )}
        style={frameStyle}
      />
      {/* Open drawer. Kept mounted (just hidden) while collapsed/hidden/no-repo so
          the xterm instances + PTYs survive the whole app session. */}
      <div
        ref={panelRef}
        aria-hidden={!visible || terminalView !== "open"}
        inert={!visible || terminalView !== "open"}
        className={cn(
          // `transform-gpu` keeps the drawer on its own compositing layer for
          // good. Without it WebKit only promotes it while the collapse
          // transition runs, so any repaint of the workspace churning
          // underneath (diff-row hover, for one) re-rasterizes the overlay —
          // which reads as the terminal blinking out and back as the pointer
          // crosses the panel edge.
          "absolute z-[45] min-w-0 transform-gpu overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm transition-[opacity,transform] duration-150 dark:border-white/5 dark:bg-neutral-900",
          // Mutually exclusive display: `hidden` (display:none, panes persist)
          // vs. the drawer's flex column — never both, so display:none can't lose
          // to `flex` on class ordering.
          !visible ? "hidden" : "flex flex-col",
          visible &&
            terminalView === "collapsed" &&
            "pointer-events-none translate-y-3 scale-[0.98] opacity-0",
        )}
        style={frameStyle}
      >
        {!terminalExpanded && (
          <TerminalResizeHandles
            panelRef={panelRef}
            adjustHeight={adjustTerminalHeight}
            setVertical={setTerminalVertical}
            setInsets={setTerminalHorizontalInsets}
          />
        )}

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
            <button type="button"
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
            <button type="button"
              onClick={clearTerminal}
              title="Clear terminal"
              aria-label="Clear terminal"
              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
            >
              <ClearIcon />
            </button>
            <button type="button"
              onClick={toggleTerminalExpanded}
              title={terminalExpanded ? "Restore terminal size" : "Maximize terminal"}
              aria-label={terminalExpanded ? "Restore terminal size" : "Maximize terminal"}
              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
            >
              {terminalExpanded ? <RestoreIcon /> : <ExpandIcon />}
            </button>
            <button type="button"
              onClick={collapseTerminal}
              title="Collapse"
              aria-label="Collapse"
              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
            >
              <CollapseIcon />
            </button>
            <button type="button"
              onClick={hideTerminal}
              title="Hide terminal"
              aria-label="Hide terminal"
              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Tab strip — one shell per tab, scoped to the active repo. */}
        <div className="flex h-9 shrink-0 items-center border-b border-black/5 px-2 dark:border-white/10">
          <TerminalTabs repoPath={terminalPath} />
        </div>

        {/* Pane host — every tab's xterm mounts here as an absolute child; only
            the active one is shown (see useTerminalPanes). `relative` so the
            absolute panes fill the content box inside the padding. */}
        <div ref={hostRef} className="relative min-h-0 flex-1 bg-[var(--code)] px-3 py-2" />
      </div>

      {visible && terminalView === "collapsed" && (
        <button type="button"
          onClick={expandTerminal}
          title="Expand terminal"
          aria-label={alive ? "Terminal running" : "Terminal idle"}
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
        </button>
      )}
    </>
  );
}
