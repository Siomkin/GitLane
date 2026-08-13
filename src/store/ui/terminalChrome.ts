// Terminal chrome: the floating panel's visibility, geometry, and the one-shot
// paste queued for its PTY. Never the PTYs themselves — those are repo-scoped
// and live in `store/terminals`.

import { useRepo } from "@/store/repo";
import { useTerminals } from "@/store/terminals";
import { TERMINAL_EDGE_MARGIN, TERMINAL_MAX_HEIGHT, TERMINAL_MIN_HEIGHT } from "@/lib/ui";
import type { SliceSet } from "./slice";
import { persistedKeys } from "./slice";

export type TerminalView = "hidden" | "collapsed" | "open";

export interface TerminalChromeSlice {
  /** In-app terminal: floating panel that collapses to a status pill without
   * killing the PTY. `hidden` = no chrome; `collapsed` = status launcher;
   * `open` = full floating panel. */
  terminalView: TerminalView;
  /** Per-repository terminal chrome. PTYs/tabs are already repo-scoped; this
   * keeps switching repos from opening a shell merely because another repo's
   * terminal was visible. */
  terminalViewByRepo: Record<string, TerminalView>;
  terminalHeight: number;
  /** Gap from the window's bottom edge to the popup's bottom, in px. Defaults to
   * the edge margin (flush with the workspace); the bottom drag handles raise it
   * to lift the panel off the floor while the top edge stays put. */
  terminalBottomInset: number;
  /** Saved user-selected popup edges. `null` uses the left-aligned 50% default. */
  terminalHorizontalLayout: { leftInset: number; rightInset: number } | null;
  terminalExpanded: boolean;
  /** Pending text queued to be pasted into the terminal PTY (bracketed paste).
   * Consumed by the TerminalLayer once the PTY is alive, then cleared. When
   * `command` is set, the terminal launches that agent first, then pastes
   * `text` into the agent prompt. `repoKey` and `tabId` identify the exact pane
   * whose flow queued it, so switching repos or tabs cannot retarget queued
   * text into a different shell. */
  terminalInject: {
    text: string;
    command?: string;
    repoKey: string | null;
    tabId: string | null;
    /** Correlates a failed terminal delivery with the draft poll it must stop. */
  } | null;

  toggleTerminal: () => void;
  collapseTerminal: () => void;
  expandTerminal: () => void;
  hideTerminal: () => void;
  forgetTerminalView: (repoPath: string) => void;
  toggleTerminalExpanded: () => void;
  /** Grow/shrink the popup's height (top-edge/corner drag; bottom gap fixed).
   * `maxHeight` caps it to the space above the current floor so the top edge
   * can't escape the container — the caller derives it from the live geometry. */
  adjustTerminalHeight: (dy: number, maxHeight?: number) => void;
  /** Set the popup's bottom gap and height together (bottom-edge/corner drags
   * keep the top edge fixed by moving both). */
  setTerminalVertical: (bottomInset: number, height: number) => void;
  setTerminalHorizontalInsets: (left: number, right: number) => void;
  /** Open the terminal and queue `text` to be pasted into it. When `command`
   * is provided, launch that terminal agent before pasting the text. The
   * injection is stamped with the active repo and delivers only there. */
  sendToTerminal: (text: string, command?: string) => void;
  clearTerminalInject: () => void;
}

function terminalViewPatch(
  state: Pick<TerminalChromeSlice, "terminalViewByRepo">,
  terminalView: TerminalView,
): Pick<TerminalChromeSlice, "terminalView" | "terminalViewByRepo"> {
  const repoPath = useRepo.getState().summary?.path;
  return {
    terminalView,
    terminalViewByRepo: repoPath
      ? { ...state.terminalViewByRepo, [repoPath]: terminalView }
      : state.terminalViewByRepo,
  };
}

/** Terminal chrome only — never the PTYs, which are repo-scoped and survive.
 * The new repo's remembered chrome is restored, defaulting to hidden. */
export const resetTerminalChrome = (
  s: Pick<TerminalChromeSlice, "terminalViewByRepo">,
  activeRepoPath: string | undefined,
) =>
  ({
    terminalView: (activeRepoPath ? s.terminalViewByRepo[activeRepoPath] : undefined) ?? "hidden",
    terminalExpanded: false,
  }) satisfies Pick<TerminalChromeSlice, "terminalView" | "terminalExpanded">;

export const persistedTerminalChrome = (s: TerminalChromeSlice) =>
  persistedKeys(s, [
    "terminalHeight",
    "terminalBottomInset",
    "terminalHorizontalLayout",
    "terminalExpanded",
  ]);

export function createTerminalChromeSlice(
  set: SliceSet<TerminalChromeSlice>,
): TerminalChromeSlice {
  return {
    terminalView: "hidden",
    terminalViewByRepo: {},
    terminalHeight: 480,
    terminalBottomInset: TERMINAL_EDGE_MARGIN,
    terminalHorizontalLayout: null,
    terminalExpanded: false,
    terminalInject: null,

    // Toolbar button cycles the visible terminal chrome. Hiding never kills a
    // shell — panes persist per repo so reopening restores them; a PTY dies only
    // when the user closes its tab (see `store/terminals`).
    toggleTerminal: () =>
      set((s) => {
        const view =
          s.terminalView === "hidden" ? "open" : s.terminalView === "open" ? "collapsed" : "open";
        return terminalViewPatch(s, view);
      }),
    collapseTerminal: () => set((s) => terminalViewPatch(s, "collapsed")),
    expandTerminal: () => set((s) => terminalViewPatch(s, "open")),
    hideTerminal: () => set((s) => ({ ...terminalViewPatch(s, "hidden"), terminalExpanded: false })),
    forgetTerminalView: (repoPath) =>
      set((s) => {
        if (!(repoPath in s.terminalViewByRepo)) return s;
        const { [repoPath]: _forgotten, ...terminalViewByRepo } = s.terminalViewByRepo;
        return {
          terminalViewByRepo,
          terminalView: useRepo.getState().summary?.path === repoPath ? "hidden" : s.terminalView,
        };
      }),
    toggleTerminalExpanded: () => set((s) => ({ terminalExpanded: !s.terminalExpanded })),
    // Down = taller. Clamp so the compact panel stays usable without eating the whole window.
    adjustTerminalHeight: (dy, maxHeight = TERMINAL_MAX_HEIGHT) =>
      set((s) => ({
        terminalHeight: Math.max(
          TERMINAL_MIN_HEIGHT,
          Math.min(TERMINAL_MAX_HEIGHT, maxHeight, s.terminalHeight + dy),
        ),
      })),
    setTerminalVertical: (bottomInset, height) =>
      set({
        terminalBottomInset: Math.max(
          TERMINAL_EDGE_MARGIN,
          Math.min(8192, Math.round(bottomInset)),
        ),
        terminalHeight: Math.max(
          TERMINAL_MIN_HEIGHT,
          Math.min(TERMINAL_MAX_HEIGHT, Math.round(height)),
        ),
      }),
    setTerminalHorizontalInsets: (left, right) =>
      set({
        terminalHorizontalLayout: {
          leftInset: Math.max(TERMINAL_EDGE_MARGIN, Math.min(8192, Math.round(left))),
          rightInset: Math.max(TERMINAL_EDGE_MARGIN, Math.min(8192, Math.round(right))),
        },
      }),
    // Open the terminal and stash the message; the TerminalLayer pastes it once the
    // PTY is alive (it watches `terminalInject` + the live flag). Stamped with the
    // repo + tab whose flow queued it (one-shot cross-store read) so it can never
    // deliver into another shell (GL-281).
    sendToTerminal: (text, command) => {
      const repoKey = useRepo.getState().summary?.path ?? null;
      let tabId: string | null = null;
      // A live PTY does not reveal whether its foreground program is the shell,
      // this agent, another agent, or an unrelated TUI. Every agent launch gets
      // a fresh tab so its command can never be typed into an unknown prompt.
      if (repoKey) {
        const terminals = useTerminals.getState();
        tabId = command ? terminals.openTab(repoKey) : terminals.ensureTab(repoKey);
      }
      set((s) => ({
        ...terminalViewPatch(s, "open"),
        terminalInject: command ? { text, command, repoKey, tabId } : { text, repoKey, tabId },
      }));
    },
    clearTerminalInject: () =>
      set((s) => (s.terminalInject === null ? s : { terminalInject: null })),
  };
}
