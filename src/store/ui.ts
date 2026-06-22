// Cross-cutting UI state that isn't repository data: theme + density, the
// settings modal, transient overlays (toast, drag action menu, context menu,
// create-branch dialog) and the pull-request view selection. Kept separate
// from `useRepo` so view chrome never re-renders on git data churn.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { usePulls } from "./pulls";
import type { PrFilter } from "../lib/prs";
import type { AccentColor } from "../lib/accent";
import type { BranchDragRef, GraphDropTarget } from "../lib/graphActions";
import { resolveTheme, systemPrefersDark } from "../lib/theme";

export type { AccentColor };
export type Theme = "dark" | "light" | "system";
export type Density = "Comfortable" | "Compact";
export type SettingsTab = "general" | "accounts" | "repo" | "terminal";
/** Commit-list kind filter in the History view: everything, regular (non-merge)
 * commits, merges, or commits carrying a tag. */
export type HistFilter = "all" | "commits" | "merges" | "tags";
// Re-exported so existing `store/ui` importers keep one import site; the union
// itself is defined in lib/prs.ts (single source of truth).
export type { PrFilter };

/** Drag-and-drop action menu raised when a ref is dropped on a writable graph target. */
export interface ActionMenu {
  x: number;
  y: number;
  from: BranchDragRef;
  to: GraphDropTarget;
}

export interface ContextMenu {
  x: number;
  y: number;
  branch: string;
  isCurrent: boolean;
}

export interface CommitMenu {
  x: number;
  y: number;
  sha: string;
  shortSha: string;
  /** The full multi-selection snapshot when the menu opened, so the menu can
   * switch to batch labels (cherry-pick N, compare range…). Omitted/empty for a
   * single right-click. */
  selection?: string[];
}

export interface StashMenu {
  x: number;
  y: number;
  index: number;
  message: string;
}

/** Right-click menu on a file row — working-changes rows and a committed
 * commit's changed-file list. */
export interface FileMenu {
  x: number;
  y: number;
  /** Repo-relative path of the file. */
  path: string;
  /** Working-tree discard target. Present for working-changes rows (drives the
   * "Discard"/"Unstage & discard" item); omitted for committed files, whose
   * changes can't be discarded — they get a copy-only menu. */
  discard?: { staged: boolean };
}

export interface Toast {
  id: number;
  message: string;
  tone: "ok" | "error";
}

/** A pending confirmation prompt for a destructive action (drop stash, delete
 * branch, hard reset, …). Rendered as an in-app modal — native `window.confirm`
 * is unreliable in the Tauri webview, so we never use it. */
export interface ConfirmRequest {
  title: string;
  /** Optional second line with detail / the irreversible consequence. */
  message?: string;
  /** Confirm-button label (default "Confirm"). */
  confirmLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
  /** Run when the user confirms. */
  onConfirm: () => void;
}

/** A pending text-input prompt (rename branch, tag name, squash message, …).
 * Rendered as an in-app modal — native `window.prompt` is unreliable in the
 * Tauri webview. */
export interface PromptRequest {
  title: string;
  /** Optional helper line under the title. */
  message?: string;
  /** Input placeholder. */
  placeholder?: string;
  /** Pre-filled value (e.g. the current branch name when renaming). */
  defaultValue?: string;
  /** Use a multiline editor for full commit messages or longer text. */
  multiline?: boolean;
  /** Submit-button label (default "OK"). */
  confirmLabel?: string;
  /** Run with the trimmed value; only fired when the input is non-empty. */
  onSubmit: (value: string) => void;
}

/** A freeform review note pinned to a single diff line. Session-only — never
 * persisted; collected in a tray and bundled into the "message for agent". */
export interface ReviewNote {
  /** Deterministic key: JSON `[file, side, line]` (one note per line). */
  id: string;
  /** Path of the file the line belongs to. */
  file: string;
  /** Diff side: "L" = old/deleted line, "R" = new/added/context line. */
  side: "L" | "R";
  /** Line number on that side. */
  line: number;
  /** Display ref, e.g. "R20" / "L4". */
  lineRef: string;
  /** The line's source text, captured for context in the agent message. */
  code: string;
  /** The reviewer's note. */
  body: string;
}

interface UiState {
  theme: Theme;
  accent: AccentColor;
  density: Density;
  filter: string;
  collapsed: Record<string, boolean>;

  leftWidth: number;
  rightWidth: number;
  /** Resizable history columns. `graphWidth` null = auto-fit to lane count. */
  branchWidth: number;
  graphWidth: number | null;
  whenWidth: number;

  settingsOpen: boolean;
  settingsTab: SettingsTab;
  addAccountOpen: boolean;

  /** Branch navigator dropdown raised by the "Checked out" trigger. Transient. */
  navOpen: boolean;
  draggingFrom: BranchDragRef | null;
  actionMenu: ActionMenu | null;
  contextMenu: ContextMenu | null;
  commitMenu: CommitMenu | null;
  stashMenu: StashMenu | null;
  fileMenu: FileMenu | null;
  /** In-app terminal: floating panel that collapses to a status pill without
   * killing the PTY. `hidden` = no panel (PTY killed); `collapsed` = pill;
   * `open` = full floating panel. */
  terminalView: "hidden" | "collapsed" | "open";
  terminalHeight: number;
  terminalExpanded: boolean;
  /** Pending text queued to be pasted into the terminal PTY (bracketed paste).
   * Consumed by the TerminalLayer once the PTY is alive, then cleared. When
   * `command` is set, the terminal launches that agent first, then pastes
   * `text` into the agent prompt. */
  terminalInject: { text: string; command?: string } | null;
  createBranchOpen: boolean;
  createBranchStart: string | null;
  /** When set, the center pane shows a stacked all-files review for this oid
   * (a commit or a stash commit), or — when `range` is set — the combined diff
   * of the base..head range. */
  stackedReview: {
    oid: string;
    title: string;
    /** When present, fetch via diffRange/diffRangeFile instead of the single-oid
     * commit helpers. `oid` is reused as the head of the range for titling. */
    range?: { base: string; head: string };
  } | null;

  prFilter: PrFilter;
  prSelected: number | null;
  prTab: "info" | "diff" | "checks" | "commits";
  /** The "New pull request" modal raised from the PR list header. */
  createPrOpen: boolean;
  /** Changes view: false = single-file review (default), true = stacked all-files. */
  changesAll: boolean;

  /** History view incremental search + kind filter over the commit list.
   * Lives in this store like the PR `prFilter`, but — unlike `prFilter` — is
   * intentionally excluded from `partialize`, so it never persists: the search
   * bar starts closed and unfiltered each session, and resets on repo switch. */
  histSearchOpen: boolean;
  histQuery: string;
  histFilter: HistFilter;
  histFilterOpen: boolean;

  /** The "Commit Changes" modal raised by the Start-commit button. Operates on
   * the staged set: each file can be excluded from this commit (unchecked), and
   * the body switches between a flat List and a collapsible Tree + inline diff. */
  commitOpen: boolean;
  commitView: "list" | "tree";
  /** Path of the file previewed in the tree view's diff pane. */
  commitSelFile: string | null;
  /** Collapsed directories in the tree view (keyed by the joined dir path). */
  commitCollapsed: Record<string, boolean>;
  /** Staged paths the user unchecked — excluded from this commit (unstaged
   * before committing, so they survive as working changes). */
  commitExcluded: Record<string, boolean>;
  /** Draft commit message (empty = let the agent write it). */
  commitMsg: string;

  /** Session-only review notes pinned to diff lines — the input to the "prepare
   * message for agent" flow. Never persisted (cleared on repo switch). */
  reviewNotes: ReviewNote[];
  /** The "prepare message for agent" popup. */
  agentMessageOpen: boolean;

  /** Pending destructive-action confirmation modal (null = none open). */
  confirm: ConfirmRequest | null;
  /** Pending text-input modal (null = none open). */
  prompt: PromptRequest | null;

  toast: Toast | null;
  /** Floating tooltip (e.g. full branch name on hover of a truncated pill). */
  tooltip: { text: string; x: number; y: number } | null;
  showTooltip: (text: string, x: number, y: number) => void;
  hideTooltip: () => void;

  adjustLeftWidth: (dx: number) => void;
  adjustRightWidth: (dx: number) => void;
  adjustBranchWidth: (dx: number) => void;
  setGraphWidth: (w: number) => void;
  adjustWhenWidth: (dx: number) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAccent: (accent: AccentColor) => void;
  setDensity: (density: Density) => void;
  setFilter: (filter: string) => void;
  toggleCollapse: (key: string) => void;

  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setAddAccountOpen: (open: boolean) => void;

  openNav: () => void;
  closeNav: () => void;
  toggleNav: () => void;
  startDrag: (branch: BranchDragRef) => void;
  clearDrag: () => void;
  openActionMenu: (menu: ActionMenu) => void;
  openContextMenu: (menu: ContextMenu) => void;
  openCommitMenu: (menu: CommitMenu) => void;
  openStashMenu: (menu: StashMenu) => void;
  openFileMenu: (menu: FileMenu) => void;
  toggleTerminal: () => void;
  collapseTerminal: () => void;
  expandTerminal: () => void;
  hideTerminal: () => void;
  toggleTerminalExpanded: () => void;
  adjustTerminalHeight: (dy: number) => void;
  /** Open the terminal and queue `text` to be pasted into it. When `command`
   * is provided, launch that terminal agent before pasting the text. */
  sendToTerminal: (text: string, command?: string) => void;
  clearTerminalInject: () => void;
  closeOverlays: () => void;
  setCreateBranchOpen: (open: boolean) => void;
  openCreateBranchFrom: (start: string | null) => void;
  openStackedReview: (oid: string, title: string) => void;
  /** Open the stacked review for a commit range (base..head combined diff). */
  openRangeReview: (base: string, head: string, title: string) => void;
  closeStackedReview: () => void;

  setPrFilter: (filter: PrFilter) => void;
  selectPr: (num: number) => void;
  setPrTab: (tab: "info" | "diff" | "checks" | "commits") => void;
  openCreatePr: () => void;
  closeCreatePr: () => void;
  setChangesAll: (all: boolean) => void;

  /** Toggle the commit search bar; closing it clears the query. */
  toggleHistSearch: () => void;
  setHistQuery: (query: string) => void;
  /** Clear just the search query, keeping the bar open and the kind filter. */
  clearHistQuery: () => void;
  /** Toggle the "Show" kind-filter chip row. */
  toggleHistFilter: () => void;
  setHistFilter: (filter: HistFilter) => void;
  /** Reset both search query and kind filter to their inert state. */
  clearHistFilters: () => void;
  /** Full reset of the history view (search + filter + open panels) — used on
   * repo switch so one repo's query/filter never carries into another. */
  resetHistView: () => void;

  /** Open the commit modal (resets exclusions + message; defaults to List). */
  openCommit: () => void;
  closeCommit: () => void;
  setCommitView: (view: "list" | "tree") => void;
  selectCommitFile: (path: string) => void;
  toggleCommitCollapse: (dir: string) => void;
  /** Toggle one staged file in/out of the commit. */
  toggleCommitFile: (path: string) => void;
  /** Check/uncheck every file under a directory at once. */
  setCommitDir: (paths: string[], included: boolean) => void;
  setCommitMsg: (msg: string) => void;

  /** Pin/replace a review note on a diff line (keyed by file+side+line). */
  addReviewNote: (note: Omit<ReviewNote, "id">) => void;
  removeReviewNote: (id: string) => void;
  clearReviewNotes: () => void;
  openAgentMessage: () => void;
  closeAgentMessage: () => void;

  /** Open the destructive-action confirmation modal. */
  requestConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;

  /** Open the text-input modal. */
  requestPrompt: (req: PromptRequest) => void;
  closePrompt: () => void;

  showToast: (message: string, tone?: "ok" | "error") => void;
  dismissToast: () => void;
}

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
  theme: "dark",
  accent: "green",
  density: "Compact",
  filter: "",
  collapsed: {},

  leftWidth: 300,
  rightWidth: 374,
  branchWidth: 150,
  graphWidth: null,
  whenWidth: 96,

  settingsOpen: false,
  settingsTab: "general",
  addAccountOpen: false,

  navOpen: false,
  draggingFrom: null,
  actionMenu: null,
  contextMenu: null,
  commitMenu: null,
  stashMenu: null,
  fileMenu: null,
  terminalView: "hidden",
  terminalHeight: 480,
  terminalExpanded: false,
  terminalInject: null,
  createBranchOpen: false,
  createBranchStart: null,
  stackedReview: null,

  prFilter: "open",
  prSelected: null,
  prTab: "info",
  createPrOpen: false,
  changesAll: false,

  histSearchOpen: false,
  histQuery: "",
  histFilter: "all",
  histFilterOpen: false,

  commitOpen: false,
  commitView: "list",
  commitSelFile: null,
  commitCollapsed: {},
  commitExcluded: {},
  commitMsg: "",

  reviewNotes: [],
  agentMessageOpen: false,
  confirm: null,
  prompt: null,

  toast: null,
  tooltip: null,

  showTooltip: (text, x, y) => set({ tooltip: { text, x, y } }),
  hideTooltip: () => set((s) => (s.tooltip ? { tooltip: null } : s)),

  adjustLeftWidth: (dx) =>
    set((s) => ({ leftWidth: Math.max(200, Math.min(460, s.leftWidth + dx)) })),
  adjustRightWidth: (dx) =>
    set((s) => ({ rightWidth: Math.max(280, Math.min(560, s.rightWidth + dx)) })),
  adjustBranchWidth: (dx) =>
    set((s) => ({ branchWidth: Math.max(130, Math.min(460, s.branchWidth + dx)) })),
  setGraphWidth: (w) => set({ graphWidth: Math.max(48, Math.min(640, w)) }),
  adjustWhenWidth: (dx) =>
    set((s) => ({ whenWidth: Math.max(64, Math.min(240, s.whenWidth + dx)) })),
  setTheme: (theme) => set({ theme }),
  // Quick toggle flips to the opposite of whatever is currently showing — so a
  // `system` preference resolves first, then lands on an explicit dark/light.
  toggleTheme: () =>
    set((s) => ({
      theme: resolveTheme(s.theme, systemPrefersDark()) === "dark" ? "light" : "dark",
    })),
  setAccent: (accent) => set({ accent }),
  setDensity: (density) => set({ density }),
  setFilter: (filter) => set({ filter }),
  toggleCollapse: (key) =>
    set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),

  openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
  closeSettings: () => set({ settingsOpen: false, addAccountOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  setAddAccountOpen: (open) => set({ addAccountOpen: open }),

  openNav: () => set({ navOpen: true }),
  closeNav: () => set((s) => (s.navOpen ? { navOpen: false } : s)),
  toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
  startDrag: (branch) => set({ draggingFrom: branch }),
  clearDrag: () => set({ draggingFrom: null }),
  openActionMenu: (menu) => set({ actionMenu: menu, draggingFrom: null, contextMenu: null, commitMenu: null, stashMenu: null, fileMenu: null }),
  openContextMenu: (menu) => set({ contextMenu: menu, actionMenu: null, commitMenu: null, stashMenu: null, fileMenu: null }),
  openCommitMenu: (menu) => set({ commitMenu: menu, actionMenu: null, contextMenu: null, stashMenu: null, fileMenu: null }),
  openStashMenu: (menu) => set({ stashMenu: menu, commitMenu: null, contextMenu: null, actionMenu: null, fileMenu: null }),
  openFileMenu: (menu) => set({ fileMenu: menu, actionMenu: null, contextMenu: null, commitMenu: null, stashMenu: null }),
  // Toolbar button cycles the visible terminal chrome. Only the panel close
  // button kills the PTY and moves the view back to hidden.
  toggleTerminal: () =>
    set((s) => ({
      terminalView:
        s.terminalView === "hidden"
          ? "open"
          : s.terminalView === "open"
            ? "collapsed"
            : "open",
    })),
  collapseTerminal: () => set({ terminalView: "collapsed" }),
  expandTerminal: () => set({ terminalView: "open" }),
  hideTerminal: () => set({ terminalView: "hidden", terminalExpanded: false }),
  toggleTerminalExpanded: () => set((s) => ({ terminalExpanded: !s.terminalExpanded })),
  // Down = taller. Clamp so the compact panel stays usable without eating the whole window.
  adjustTerminalHeight: (dy) =>
    set((s) => ({ terminalHeight: Math.max(160, Math.min(860, s.terminalHeight + dy)) })),
  // Open the terminal and stash the message; the TerminalLayer pastes it once the
  // PTY is alive (it watches `terminalInject` + the live flag).
  sendToTerminal: (text, command) =>
    set({ terminalView: "open", terminalInject: command ? { text, command } : { text } }),
  clearTerminalInject: () => set((s) => (s.terminalInject === null ? s : { terminalInject: null })),
  closeOverlays: () => set({ actionMenu: null, contextMenu: null, commitMenu: null, stashMenu: null, fileMenu: null, draggingFrom: null }),
  setCreateBranchOpen: (open) => set({ createBranchOpen: open, createBranchStart: open ? get().createBranchStart : null }),
  openCreateBranchFrom: (start) => set({ createBranchOpen: true, createBranchStart: start, commitMenu: null, contextMenu: null }),
  openStackedReview: (oid, title) => set({ stackedReview: { oid, title }, commitMenu: null }),
  openRangeReview: (base, head, title) =>
    set({ stackedReview: { oid: head, title, range: { base, head } }, commitMenu: null }),
  closeStackedReview: () => set({ stackedReview: null }),

  setPrFilter: (filter) => {
    if (get().prFilter === filter) return;
    set({ prFilter: filter });
    // The list holds all states already, but a tab change is a deliberate user
    // action — refresh so the chosen view is current and the spinner shows.
    void usePulls.getState().loadPullRequests();
  },
  selectPr: (num) => set({ prSelected: num, prTab: "info" }),
  setPrTab: (tab) => set({ prTab: tab }),
  openCreatePr: () => set({ createPrOpen: true }),
  closeCreatePr: () => set({ createPrOpen: false }),
  setChangesAll: (all) => set({ changesAll: all }),

  toggleHistSearch: () =>
    set((s) => ({ histSearchOpen: !s.histSearchOpen, histQuery: s.histSearchOpen ? "" : s.histQuery })),
  setHistQuery: (query) => set({ histQuery: query }),
  clearHistQuery: () => set((s) => (s.histQuery === "" ? s : { histQuery: "" })),
  toggleHistFilter: () => set((s) => ({ histFilterOpen: !s.histFilterOpen })),
  setHistFilter: (filter) => set({ histFilter: filter }),
  clearHistFilters: () => set((s) => (s.histQuery === "" && s.histFilter === "all" ? s : { histQuery: "", histFilter: "all" })),
  resetHistView: () =>
    set((s) =>
      !s.histSearchOpen && s.histQuery === "" && s.histFilter === "all" && !s.histFilterOpen
        ? s
        : { histSearchOpen: false, histQuery: "", histFilter: "all", histFilterOpen: false },
    ),

  openCommit: () =>
    set({ commitOpen: true, commitView: "list", commitExcluded: {}, commitMsg: "", commitSelFile: null }),
  closeCommit: () => set({ commitOpen: false }),
  setCommitView: (view) => set({ commitView: view }),
  selectCommitFile: (path) => set({ commitSelFile: path }),
  toggleCommitCollapse: (dir) =>
    set((s) => ({ commitCollapsed: { ...s.commitCollapsed, [dir]: !s.commitCollapsed[dir] } })),
  toggleCommitFile: (path) =>
    set((s) => {
      const next = { ...s.commitExcluded };
      if (next[path]) delete next[path];
      else next[path] = true;
      return { commitExcluded: next };
    }),
  setCommitDir: (paths, included) =>
    set((s) => {
      const next = { ...s.commitExcluded };
      for (const p of paths) {
        if (included) delete next[p];
        else next[p] = true;
      }
      return { commitExcluded: next };
    }),
  setCommitMsg: (msg) => set({ commitMsg: msg }),

  addReviewNote: (note) =>
    set((s) => {
      // One note per line: replace any existing note on the same file+side+line.
      const id = JSON.stringify([note.file, note.side, note.line]);
      const rest = s.reviewNotes.filter((n) => n.id !== id);
      return { reviewNotes: [...rest, { ...note, id }] };
    }),
  removeReviewNote: (id) =>
    set((s) => ({ reviewNotes: s.reviewNotes.filter((n) => n.id !== id) })),
  clearReviewNotes: () =>
    set((s) => (s.reviewNotes.length ? { reviewNotes: [], agentMessageOpen: false } : s)),
  openAgentMessage: () => set({ agentMessageOpen: true }),
  closeAgentMessage: () => set({ agentMessageOpen: false }),

  requestConfirm: (req) =>
    set({ confirm: req, actionMenu: null, contextMenu: null, commitMenu: null, stashMenu: null, fileMenu: null }),
  closeConfirm: () => set({ confirm: null }),

  requestPrompt: (req) =>
    set({ prompt: req, actionMenu: null, contextMenu: null, commitMenu: null, stashMenu: null, fileMenu: null }),
  closePrompt: () => set({ prompt: null }),

  showToast: (message, tone = "ok") => {
    const id = (toastSeq += 1);
    set({ toast: { id, message, tone } });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 2400);
  },
  dismissToast: () => set({ toast: null }),
    }),
    {
      name: "gitlane.ui",
      // Only persist user-chosen view preferences — never transient overlays
      // (menus, toasts, drag state) or repo/account data that lives elsewhere.
      partialize: (s) => ({
        theme: s.theme,
        accent: s.accent,
        density: s.density,
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        branchWidth: s.branchWidth,
        graphWidth: s.graphWidth,
        whenWidth: s.whenWidth,
        terminalHeight: s.terminalHeight,
        terminalExpanded: s.terminalExpanded,
        prFilter: s.prFilter,
        collapsed: s.collapsed,
      }),
    },
  ),
);

export const rowHeightFor = (density: Density) => (density === "Comfortable" ? 46 : 34);
