// Cross-cutting UI state that isn't repository data: theme + density, the
// settings modal, transient overlays (toast, drag action menu, context menu,
// create-branch dialog) and the pull-request view selection. Kept separate
// from `useRepo` so view chrome never re-renders on git data churn.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { usePulls } from "./pulls";
import { friendlyGitError } from "../lib/gitError";
import type { PrFilter } from "../lib/prs";
import type { AccentColor } from "../lib/accent";
import type { BranchDragRef, GraphDropTarget } from "../lib/graphActions";
import { resolveTheme, systemPrefersDark } from "../lib/theme";

export type { AccentColor };
export type Theme = "dark" | "light" | "system";
export type Density = "Comfortable" | "Compact";
export type SettingsTab = "general" | "profiles" | "accounts" | "terminal" | "about";

/** Seed values handed to the global Profiles editor when a repo-scoped surface
 * starts a create (e.g. adopting an unmanaged local identity). */
export interface ProfilePrefill {
  name?: string;
  email?: string;
  signingKey?: string;
  gpgFormat?: "openpgp" | "ssh";
  gpgSign?: boolean;
  tagGpgSign?: boolean;
}

/** A pending editor request for Settings → Profiles, set by repo-scoped
 * surfaces (the repo Identity panel, the title-bar chip) when they hand off
 * profile creation/editing to the global panel. Consumed once on mount. */
export type ProfilesIntent =
  | { kind: "new"; prefill?: ProfilePrefill }
  | { kind: "edit"; id: string };

/** Sections of the repo-scoped Repository settings window — split out of the
 * global Settings modal so per-repo config (identity, remotes) is its own
 * window opened from the toolbar, not a tab under the title-bar gear. */
export type RepoSettingsSection = "identity" | "remotes";
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

/** Right-click menu on the synthetic "uncommitted changes" (WIP) row. Carries
 * no payload — it acts on the whole working tree, read from the repo store. */
export interface WipMenu {
  x: number;
  y: number;
}

/** Right-click menu on a tag ref (a pill in the graph or a navigator row).
 * `sha` is the commit the tag points to, for checkout / branch / worktree. */
export interface TagMenu {
  x: number;
  y: number;
  name: string;
  sha: string;
}

/** Right-click menu on a worktree row in the navigator. */
export interface WorktreeMenu {
  x: number;
  y: number;
  /** Absolute path of the linked worktree. */
  path: string;
  /** Display label (its branch, falling back to the worktree name). */
  name: string;
  /** The primary worktree can't be removed — hide that action for it. */
  isMain: boolean;
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
  /** Concrete impact lines shown before the action runs. */
  details?: string[];
  /** High-risk consequences or recovery limitations. */
  warnings?: string[];
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
/** A pickable suggestion in a prompt's combobox list. Selecting a row submits
 * with its `value`; the typed text still acts as a free-text fallback so refs
 * outside the list (a raw SHA, `HEAD~1`) stay reachable. */
export interface PromptOption {
  value: string;
  /** Display text (defaults to `value`). */
  label?: string;
  /** Muted right-aligned hint shown on the row (e.g. "current", "remote"). */
  hint?: string;
}

/** A pending worktree branch hand-off (GL-74), rendered by the dedicated
 * HandoffDialog: destination picker → live step checklist → success message.
 * Only the subject crosses the store; the dialog owns destination choice and
 * run/progress state (transient, per-open). */
export interface HandoffRequest {
  /** The branch being handed off. */
  branch: string;
  /** Absolute path of the worktree the branch is moving out of. */
  sourcePath: string;
  /** Count of the source's uncommitted files, or null when unknown (the flow
   * was started from a menu whose worktree isn't the open repo). */
  sourceChanges: number | null;
}

export interface PromptRequest {
  title: string;
  /** Optional helper line under the title. */
  message?: string;
  /** Input placeholder. */
  placeholder?: string;
  /** Pre-filled value (e.g. the current branch name when renaming). With
   * `options`, this pre-highlights the matching row instead of pre-filling the
   * search box. */
  defaultValue?: string;
  /** Use a multiline editor for full commit messages or longer text. */
  multiline?: boolean;
  /** Submit-button label (default "OK"). */
  confirmLabel?: string;
  /** When set, the field becomes a searchable picker over these options (like
   * the branch navigator) rather than a bare text input — so the user selects
   * instead of typing the exact ref. The typed text filters the list; a typed
   * value not in the list is still accepted on submit. */
  options?: PromptOption[];
  /** Optional synchronous validator for the trimmed value. Returns an error
   * message to block submission (shown inline, submit disabled) or `null` when
   * valid. Not used with `options`. */
  validate?: (value: string) => string | null;
  /** Run with the trimmed value; only fired when the input is non-empty. */
  onSubmit: (value: string) => void;
}

/** A freeform review ("local") comment pinned to a contiguous range of diff
 * lines. Session-only — never persisted; collected and bundled into the "hand to
 * agent" message. A single-line comment is just a range whose ends coincide. */
export interface ReviewNote {
  /** Deterministic key: `${surface}#${file}#${fromRef}-${toRef}` (one note per range). */
  id: string;
  /** The diff surface this note belongs to (e.g. "work", "commit:<oid>",
   * "range:<base>..<head>", "pr:<num>"), so the same file/line in a different
   * diff doesn't re-attach the note or fold it into the wrong hand-off. */
  surface: string;
  /** Path of the file the range belongs to. */
  file: string;
  /** Anchor (range-end) side, kept for stable ordering. "L" = old, "R" = new/ctx. */
  side: "L" | "R";
  /** Anchor (range-end) line number on that side, kept for ordering. */
  line: number;
  /** Display ref of the range start, e.g. "R18" / "L4". */
  fromRef: string;
  /** Display ref of the range end (the anchor), e.g. "R20". */
  toRef: string;
  /** Combined display label, e.g. "R20" or "R18–R20". */
  lineRef: string;
  /** The range's source text (joined), captured for context in the message. */
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

  /** When true, GitLane runs a quiet update check at most once a day on launch
   * (the About panel's toggle). `lastUpdateCheckAt` is the epoch ms of the last
   * attempt, used to throttle that daily check. Both persist. */
  autoCheckUpdates: boolean;
  lastUpdateCheckAt: number;

  leftWidth: number;
  rightWidth: number;
  /** Resizable history graph column width, keyed by normalized repo path. */
  branchWidth: number;
  graphWidthsByRepo: Record<string, number>;
  whenWidth: number;

  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** Repo-scoped Repository settings window (identity / remotes), independent of
   * the global Settings modal so both can be reasoned about separately. */
  repoSettingsOpen: boolean;
  repoSettingsSection: RepoSettingsSection;
  /** Pending Settings → Profiles editor request (transient, consumed on mount). */
  profilesIntent: ProfilesIntent | null;
  addAccountOpen: boolean;
  /** Repository-onboarding overlay (clone / init / open) raised from the tab
   * strip while a repo is already open. Transient (not persisted). */
  onboardingOpen: boolean;

  /** Branch navigator dropdown raised by the "Checked out" trigger. Transient. */
  navOpen: boolean;
  draggingFrom: BranchDragRef | null;
  actionMenu: ActionMenu | null;
  contextMenu: ContextMenu | null;
  commitMenu: CommitMenu | null;
  stashMenu: StashMenu | null;
  fileMenu: FileMenu | null;
  wipMenu: WipMenu | null;
  tagMenu: TagMenu | null;
  worktreeMenu: WorktreeMenu | null;
  recoveryOpen: boolean;
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
   * of the base..head range, or — when `selection` is set — the merged ("union")
   * diff across a multi-commit selection. */
  stackedReview: {
    oid: string;
    title: string;
    /** When present, fetch via diffRange/diffRangeFile instead of the single-oid
     * commit helpers. `oid` is reused as the head of the range for titling. */
    range?: { base: string; head: string };
    /** When present, fetch via selectionDiff/selectionDiffFile — the merged diff
     * across these commit oids (GL-69). `oid` is reused as a stable cache key. */
    selection?: string[];
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
  /** The "prepare message for agent" popup, plus the diff surface(s) + branch it
   * was opened from — so it composes from those surfaces' notes against the right
   * branch. (A set, because the working review mixes staged + unstaged sources.) */
  agentMessageOpen: boolean;
  agentMessageSurfaces: string[];
  agentMessageBranch: string | null;

  /** Pending destructive-action confirmation modal (null = none open). */
  confirm: ConfirmRequest | null;
  /** Pending text-input modal (null = none open). */
  prompt: PromptRequest | null;
  /** Pending worktree branch hand-off modal (null = none open). */
  handoff: HandoffRequest | null;
  /** True while a hand-off move is in flight. The success path routes through
   * `loadRepo(destination)`, whose repo-switch cleanup must NOT close the
   * dialog then (it's about to show the result); any other repo switch does. */
  handoffRunning: boolean;

  toast: Toast | null;
  /** Floating tooltip (e.g. full branch name on hover of a truncated pill). */
  tooltip: { text: string; x: number; y: number } | null;
  showTooltip: (text: string, x: number, y: number) => void;
  hideTooltip: () => void;

  adjustLeftWidth: (dx: number) => void;
  adjustRightWidth: (dx: number) => void;
  adjustBranchWidth: (dx: number) => void;
  setRepoGraphWidth: (repoPath: string, w: number) => void;
  adjustWhenWidth: (dx: number) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAccent: (accent: AccentColor) => void;
  setDensity: (density: Density) => void;
  setAutoCheckUpdates: (on: boolean) => void;
  /** Stamp the last update-check time (called by the updates store on any check). */
  markUpdateChecked: () => void;
  setFilter: (filter: string) => void;
  toggleCollapse: (key: string) => void;

  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  /** Open global Settings → Profiles, optionally queueing an editor intent
   * (new/edit) for the panel to consume. */
  openProfilesSettings: (intent?: ProfilesIntent) => void;
  /** Clear the pending Profiles editor request once the panel has consumed it. */
  clearProfilesIntent: () => void;
  /** Open the repo-scoped Repository settings window (default: last section). */
  openRepoSettings: (section?: RepoSettingsSection) => void;
  closeRepoSettings: () => void;
  setRepoSettingsSection: (section: RepoSettingsSection) => void;
  setAddAccountOpen: (open: boolean) => void;
  /** Raise / dismiss the repository-onboarding overlay from within an open repo. */
  openOnboarding: () => void;
  closeOnboarding: () => void;

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
  openWipMenu: (menu: WipMenu) => void;
  openTagMenu: (menu: TagMenu) => void;
  openWorktreeMenu: (menu: WorktreeMenu) => void;
  openRecovery: () => void;
  closeRecovery: () => void;
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
  /** Open the stacked review for the merged diff across a multi-commit selection. */
  openSelectionReview: (commits: string[], title: string) => void;
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

  /** Pin/replace a local comment on a diff line range (keyed by file + range). */
  addReviewNote: (note: Omit<ReviewNote, "id">) => void;
  removeReviewNote: (id: string) => void;
  clearReviewNotes: () => void;
  openAgentMessage: (surfaces: string[], branch: string | null) => void;
  closeAgentMessage: () => void;

  /** Open the destructive-action confirmation modal. */
  requestConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;

  /** Open the text-input modal. */
  requestPrompt: (req: PromptRequest) => void;
  closePrompt: () => void;

  /** Open the worktree hand-off modal. */
  openHandoff: (req: HandoffRequest) => void;
  closeHandoff: () => void;
  /** Flag a hand-off move as in flight (set by the dialog's run hook). */
  setHandoffRunning: (running: boolean) => void;

  showToast: (message: string, tone?: "ok" | "error") => void;
  dismissToast: () => void;
}

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Every transient context/action menu cleared at once. Spread into any `set`
 * that opens a menu, modal, or review so exactly one menu is ever live. */
const noMenus = {
  actionMenu: null,
  contextMenu: null,
  commitMenu: null,
  stashMenu: null,
  fileMenu: null,
  wipMenu: null,
  tagMenu: null,
  worktreeMenu: null,
} satisfies Partial<UiState>;

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
  theme: "dark",
  accent: "green",
  density: "Compact",
  filter: "",
  collapsed: {},

  autoCheckUpdates: true,
  lastUpdateCheckAt: 0,

  leftWidth: 300,
  rightWidth: 374,
  branchWidth: 150,
  graphWidthsByRepo: {},
  whenWidth: 96,

  settingsOpen: false,
  settingsTab: "general",
  repoSettingsOpen: false,
  repoSettingsSection: "identity",
  profilesIntent: null,
  addAccountOpen: false,
  onboardingOpen: false,

  navOpen: false,
  draggingFrom: null,
  actionMenu: null,
  contextMenu: null,
  commitMenu: null,
  stashMenu: null,
  fileMenu: null,
  wipMenu: null,
  tagMenu: null,
  worktreeMenu: null,
  recoveryOpen: false,
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
  agentMessageSurfaces: [],
  agentMessageBranch: null,
  confirm: null,
  prompt: null,
  handoff: null,
  handoffRunning: false,

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
  setRepoGraphWidth: (repoPath, w) =>
    set((s) => ({
      graphWidthsByRepo: {
        ...s.graphWidthsByRepo,
        [repoPath]: Math.max(48, Math.min(640, w)),
      },
    })),
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
  setAutoCheckUpdates: (on) => set({ autoCheckUpdates: on }),
  markUpdateChecked: () => set({ lastUpdateCheckAt: Date.now() }),
  setFilter: (filter) => set({ filter }),
  toggleCollapse: (key) =>
    set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),

  openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
  closeSettings: () => set({ settingsOpen: false, addAccountOpen: false, profilesIntent: null }),
  openRepoSettings: (section) =>
    set((s) => ({ repoSettingsOpen: true, repoSettingsSection: section ?? s.repoSettingsSection })),
  closeRepoSettings: () => set({ repoSettingsOpen: false }),
  setRepoSettingsSection: (section) => set({ repoSettingsSection: section }),
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => set({ onboardingOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  openProfilesSettings: (intent) =>
    set({ settingsOpen: true, settingsTab: "profiles", profilesIntent: intent ?? null }),
  clearProfilesIntent: () => set((s) => (s.profilesIntent === null ? s : { profilesIntent: null })),
  setAddAccountOpen: (open) => set({ addAccountOpen: open }),

  openNav: () => set({ navOpen: true }),
  closeNav: () => set((s) => (s.navOpen ? { navOpen: false } : s)),
  toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
  startDrag: (branch) => set({ draggingFrom: branch }),
  clearDrag: () => set({ draggingFrom: null }),
  // Menus are mutually exclusive: opening one (or any modal/overlay) clears the
  // rest. Spread `noMenus` so adding a menu type can't leave a stale sibling open.
  openActionMenu: (menu) => set({ ...noMenus, actionMenu: menu, draggingFrom: null }),
  openContextMenu: (menu) => set({ ...noMenus, contextMenu: menu }),
  openCommitMenu: (menu) => set({ ...noMenus, commitMenu: menu }),
  openStashMenu: (menu) => set({ ...noMenus, stashMenu: menu }),
  openFileMenu: (menu) => set({ ...noMenus, fileMenu: menu }),
  openWipMenu: (menu) => set({ ...noMenus, wipMenu: menu }),
  openTagMenu: (menu) => set({ ...noMenus, tagMenu: menu }),
  openWorktreeMenu: (menu) => set({ ...noMenus, worktreeMenu: menu }),
  openRecovery: () => set({ ...noMenus, recoveryOpen: true }),
  closeRecovery: () => set({ recoveryOpen: false }),
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
  closeOverlays: () => set({ ...noMenus, draggingFrom: null }),
  setCreateBranchOpen: (open) => set({ createBranchOpen: open, createBranchStart: open ? get().createBranchStart : null }),
  openCreateBranchFrom: (start) => set({ ...noMenus, createBranchOpen: true, createBranchStart: start }),
  openStackedReview: (oid, title) => set({ ...noMenus, stackedReview: { oid, title } }),
  openRangeReview: (base, head, title) =>
    set({ ...noMenus, stackedReview: { oid: head, title, range: { base, head } } }),
  openSelectionReview: (commits, title) =>
    set({ ...noMenus, stackedReview: { oid: commits[0] ?? "", title, selection: commits } }),
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
      // One note per range per surface: replace any existing note with the same key.
      const id = `${note.surface}#${note.file}#${note.fromRef}-${note.toRef}`;
      const rest = s.reviewNotes.filter((n) => n.id !== id);
      return { reviewNotes: [...rest, { ...note, id }] };
    }),
  removeReviewNote: (id) =>
    set((s) => ({ reviewNotes: s.reviewNotes.filter((n) => n.id !== id) })),
  clearReviewNotes: () =>
    set((s) => (s.reviewNotes.length ? { reviewNotes: [], agentMessageOpen: false } : s)),
  openAgentMessage: (surfaces, branch) =>
    set({ agentMessageOpen: true, agentMessageSurfaces: surfaces, agentMessageBranch: branch }),
  closeAgentMessage: () => set({ agentMessageOpen: false }),

  requestConfirm: (req) => set({ ...noMenus, confirm: req }),
  closeConfirm: () => set({ confirm: null }),

  requestPrompt: (req) => set({ ...noMenus, prompt: req }),
  closePrompt: () => set({ prompt: null }),

  openHandoff: (req) => set({ ...noMenus, handoff: req }),
  // Deliberately does NOT clear `handoffRunning`: a dismissed dialog leaves the
  // move running, and the flag must hold until it settles so loadRepo's overlay
  // cleanup can tell the hand-off's own destination switch from a genuine one.
  closeHandoff: () => set((s) => (s.handoff === null ? s : { handoff: null })),
  setHandoffRunning: (running) =>
    set((s) => (s.handoffRunning === running ? s : { handoffRunning: running })),

  showToast: (message, tone = "ok") => {
    const id = (toastSeq += 1);
    // Rewrite raw git/hook failures into a readable message (no-op for other text).
    const text = tone === "error" ? friendlyGitError(message) : message;
    set({ toast: { id, message: text, tone } });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = undefined;
    // Errors — especially multi-line hook output — stay until dismissed so they can
    // actually be read; success/info toasts auto-clear.
    if (tone !== "error") {
      toastTimer = setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, 2400);
    }
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
        autoCheckUpdates: s.autoCheckUpdates,
        lastUpdateCheckAt: s.lastUpdateCheckAt,
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        branchWidth: s.branchWidth,
        graphWidthsByRepo: s.graphWidthsByRepo,
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
