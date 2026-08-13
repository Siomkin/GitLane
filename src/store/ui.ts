// Cross-cutting UI state that isn't repository data: theme + density, the
// settings modal, transient overlays (toast, drag action menu, context menu,
// create-branch dialog) and the pull-request view selection. Kept separate
// from `useRepo` so view chrome never re-renders on git data churn.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { usePulls } from "./pulls";
import { useRepo } from "./repo";
import { useNotifications, type NotifyAction } from "./notifications";
import { useTerminals } from "./terminals";
import { authFailureProvider, classifyGitAuthFailure, classifyIndexLockFailure, friendlyGitError } from "@/lib/gitError";
import { api, type AcpAgent, type ForgeAuthProvider, type WorktreeInfo } from "@/lib/api";
import type { AiActionScope } from "@/features/agents/ai-actions/aiActions";
import {
  TERMINAL_EDGE_MARGIN,
  TERMINAL_MAX_HEIGHT,
  TERMINAL_MIN_HEIGHT,
  FileListView,
  type LeftTab,
  type RightTab,
} from "@/lib/ui";
import type { PrFilter } from "@/lib/prs";
import type { AccentColor } from "@/lib/accent";
import { ComposerMode } from "@/lib/conventionalCommit";
import type { BranchDragRef, GraphDropTarget } from "@/lib/graphActions";
import {
  createAppearanceSlice,
  persistedAppearance,
  type AppearanceSlice,
} from "./ui/appearance";
import {
  createGraphFilterSlice,
  persistedGraphFilter,
  type GraphFilterSlice,
} from "./ui/graphFilter";
import {
  createHistorySearchSlice,
  resetHistorySearch,
  type HistorySearchSlice,
} from "./ui/historySearch";
import {
  createPanelWidthsSlice,
  persistedPanelWidths,
  type PanelWidthsSlice,
} from "./ui/panels";
import { createTooltipSlice, type TooltipSlice } from "./ui/tooltip";
import {
  createUpdatePrefsSlice,
  persistedUpdatePrefs,
  type UpdatePrefsSlice,
} from "./ui/updatePrefs";

export type { AccentColor };
// The six independent concerns live under `ui/` (GL-357); their public types are
// re-exported here so importers keep one import site.
export type { Density, Theme } from "./ui/appearance";
import type { Density } from "./ui/appearance";
export type { HistFilter } from "./ui/historySearch";
export {
  AUTO_FETCH_MINUTES,
  DEFAULT_AUTO_FETCH_MINUTES,
  sanitizeAutoFetchMinutes,
  type AutoFetchMinutes,
} from "./ui/updatePrefs";
export type TerminalView = "hidden" | "collapsed" | "open";
export type SettingsTab =
  | "general"
  | "accounts"
  | "identities"
  | "agents"
  | "terminal"
  | "prompts"
  | "shortcuts"
  | "about";

/** Re-exported so the draft action's signature has one import site. */
export type { AcpAgent };

/** An in-flight agent commit-message draft. Scoped to the repository that
 * launched it so a late answer can never land in another repo's composer. */
export interface AgentCommitDraftRequest {
  token: string;
  agentName: string;
  repoPath: string;
  startedAt: number;
}

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
export type IdentitiesIntent =
  | { kind: "new"; prefill?: ProfilePrefill }
  | { kind: "edit"; id: string };

/** A pending connect request for Settings → Accounts: which provider's connect
 * view to land on. Set by auth-failure surfaces ("Fix authentication…"),
 * consumed once by the Accounts panel on mount. Never persisted. */
export type AccountsConnectIntent = "github" | ForgeAuthProvider;

/** Sections of the repo-scoped Repository settings window — split out of the
 * global Settings modal so per-repo config (identity, remotes) is its own
 * window opened from the toolbar, not a tab under the title-bar gear. */
export type RepoSettingsSection = "identity" | "remotes";
// Re-exported so existing `store/ui` importers keep one import site; the union
// itself is defined in lib/prs.ts (single source of truth).
export type { PrFilter };

/** Which menu the single open-menu slot holds. Compare against these consts,
 * never the raw strings. */
export const MenuKind = {
  Action: "action",
  Context: "context",
  Commit: "commit",
  Stash: "stash",
  File: "file",
  Wip: "wip",
  Tag: "tag",
  Worktree: "worktree",
} as const;
export type MenuKind = (typeof MenuKind)[keyof typeof MenuKind];

/** The single open-menu slot (GL-363). At most one menu is open at a time —
 * by construction: opening any menu replaces whatever was open, so the old
 * "spread noMenus in every opener" convention has nothing left to forget. */
export type OpenMenu =
  | { kind: typeof MenuKind.Action; state: ActionMenu }
  | { kind: typeof MenuKind.Context; state: ContextMenu }
  | { kind: typeof MenuKind.Commit; state: CommitMenu }
  | { kind: typeof MenuKind.Stash; state: StashMenu }
  | { kind: typeof MenuKind.File; state: FileMenu }
  | { kind: typeof MenuKind.Wip; state: WipMenu }
  | { kind: typeof MenuKind.Tag; state: TagMenu }
  | { kind: typeof MenuKind.Worktree; state: WorktreeMenu };

// Per-kind selectors for the open-menu slot — the one place that narrows it.
// Components subscribe through these (`useUi(commitMenuOf)`), so they re-render
// exactly as they did when each menu was its own field.
export const actionMenuOf = (s: UiState) =>
  s.menu?.kind === MenuKind.Action ? s.menu.state : null;
export const contextMenuOf = (s: UiState) =>
  s.menu?.kind === MenuKind.Context ? s.menu.state : null;
export const commitMenuOf = (s: UiState) =>
  s.menu?.kind === MenuKind.Commit ? s.menu.state : null;
export const stashMenuOf = (s: UiState) => (s.menu?.kind === MenuKind.Stash ? s.menu.state : null);
export const fileMenuOf = (s: UiState) => (s.menu?.kind === MenuKind.File ? s.menu.state : null);
export const wipMenuOf = (s: UiState) => (s.menu?.kind === MenuKind.Wip ? s.menu.state : null);
export const tagMenuOf = (s: UiState) => (s.menu?.kind === MenuKind.Tag ? s.menu.state : null);
export const worktreeMenuOf = (s: UiState) =>
  s.menu?.kind === MenuKind.Worktree ? s.menu.state : null;

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
  /** The stash commit oid — stable across list churn, unlike `stash@{n}`
   * indices, which shift whenever any stash is created or dropped (GL-117). */
  oid: string;
  message: string;
}

/** Right-click menu on the synthetic "uncommitted changes" (WIP) row. Carries
 * no payload — it acts on the whole working tree, read from the repo store. */
export interface WipMenu {
  x: number;
  y: number;
}

/** Right-click menu on a tag ref (a pill in the graph or a navigator row).
 * `sha` is the peeled commit for checkout / branch / worktree; `refOid` is the
 * exact lightweight/annotated tag object captured for compare-and-swap delete. */
export interface TagMenu {
  x: number;
  y: number;
  name: string;
  sha: string;
  refOid: string;
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
  /** Repo-relative path of the file, or — when `dir` is set — of the directory. */
  path: string;
  /** Set when the menu targets a Tree-view directory header rather than a file:
   * a copy-only menu (folder name / relative / full path), with none of the
   * file-specific actions (open, history, discard). Working-tree directories also
   * offer Ignore folder… (ADR 0002). */
  dir?: boolean;
  /** Working-tree discard target. Present for working-changes rows (drives the
   * Discard / Delete / Ignore items); omitted for committed files. */
  discard?: { staged: boolean };
  /** Committed-file restore target (ADR 0003). Present when the row has a blob
   * at that commit; drives Restore from this commit…. */
  restore?: { commitOid: string };
  /** Working-tree Tree-view directory header — enables Ignore folder…. */
  working?: boolean;
}

/** Which changes the AI actions popup runs over, plus the command to start on.
 *  The scope shape itself is owned by the pure domain module that reads it —
 *  a type-only import, so no runtime dependency crosses into the store. */
export type AiActionsRequest = AiActionScope & {
  /** Preselected command — review-all / Describe pass `"short"`; menus omit it
   *  and the popup starts on implementation comment. */
  action?: string;
};

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
  /** Optional alternative action rendered between Cancel and the confirm
   * button (e.g. blocked checkout: "Check out here" vs "Open that worktree").
   * Choosing it closes the dialog like a confirm. */
  secondary?: { label: string; onClick: () => void };
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
  /** Preselected destination worktree path — set by flows that already know
   * where the branch should land (e.g. "Check out here", which targets the
   * open worktree). Must be an exact destination-option value (a `wt.path`
   * from the worktree list — the dialog matches it verbatim). It only seeds
   * the picker: the run always uses the picker's final, validated value, and
   * an invalid/vanished path falls back to the first option. */
  destPath?: string;
}

/** A pending in-app GitHub sign-in (GL-106), rendered by GithubSigninDialog. Only
 * the initial host crosses the store; the dialog owns host choice, the device
 * code, and run/progress state (transient, per-open). */
export interface GithubSigninRequest {
  /** Host to sign in to, e.g. "github.com" or a GHES hostname. */
  host: string;
}

/** A pending native provider OAuth sign-in modal (GL-139). Only the provider +
 * host (and an optional remote to bind on success) cross the store; the dialog
 * owns the device code / authorize URL and run/progress state. */
export interface ProviderOauthSigninRequest {
  provider: ForgeAuthProvider;
  /** Credential host to sign in to, e.g. "gitlab.com" or "bitbucket.org". */
  host: string;
  /** When set, the remote whose URL username is pinned to the OAuth transport
   * username on success (so it immediately authenticates via `providerToken`). */
  remote?: string;
}

/** A pending combined delete of a branch and its linked worktree (GL-107),
 * rendered by DeleteWorktreeDialog: destructive preview/confirm → live step
 * checklist → success/failure. Only the subject crosses the store; the dialog
 * owns the impact preview and run/progress state (transient, per-open). */
export interface DeleteWorktreeRequest {
  /** The branch being deleted. */
  branch: string;
  /** Absolute path of the linked worktree removed before the branch is deleted. */
  worktreePath: string;
}

/** A pending bulk removal of the detached worktrees, rendered by
 * RemoveDetachedDialog: destructive preview/confirm → live per-worktree
 * checklist → summary. The sweep loop is frontend-driven (one removal per
 * target), so each target is its own checklist row that ticks (or fails) as the
 * loop reaches it. The full target list crosses the store — captured at open so
 * a mid-run worktree refresh can't rewrite the checklist. */
export interface RemoveDetachedRequest {
  /** The detached worktrees to remove, already filtered to the removable set
   * (never the main worktree or the one backing the open tab). */
  targets: WorktreeInfo[];
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

/** The selected local HEAD commit message being reworded. The dedicated
 * dialog owns its local Message / Conventional draft; only the initial value
 * and the final submit callback cross the store. */
export interface EditCommitMessageRequest {
  /** Optional helper line under the fixed "Edit commit message" title. */
  message?: string;
  /** The commit's current full message. */
  defaultValue: string;
  /** Run with the trimmed full message after the user confirms. */
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

/** The twelve entangled concerns. The six independent ones — appearance, panel
 * widths, update preferences, history search, the graph filter, the tooltip —
 * are composed in from `ui/` (GL-357); everything still declared here is bound
 * together by `onRepoSwitched`, `closeOverlays` and `partialize`. */
interface UiOwnState {
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** Repo-scoped Repository settings window (identity / remotes), independent of
   * the global Settings modal so both can be reasoned about separately. */
  repoSettingsOpen: boolean;
  repoSettingsSection: RepoSettingsSection;
  /** Pending Settings → Profiles editor request (transient, consumed on mount). */
  identitiesIntent: IdentitiesIntent | null;
  accountsConnectIntent: AccountsConnectIntent | null;
  addAccountOpen: boolean;
  /** Repository-onboarding overlay (clone / init / open) raised from the tab
   * strip while a repo is already open. Transient (not persisted). */
  onboardingOpen: boolean;

  /** Branch navigator dropdown raised by the "Checked out" trigger. Transient. */
  navOpen: boolean;
  /** Refs pinned to the top of the branch navigator's lists: repo path →
   * `pinKey(kind, name)` (e.g. `"local|develop"`) → true. Keyed by repo like
   * `graphWidthsByRepo` — a bare ref name is not unique across repositories, so
   * a flat map would pin `main` everywhere at once. Persisted. */
  pinnedNavRefsByRepo: Record<string, Record<string, true>>;
  draggingFrom: BranchDragRef | null;
  /** The single open-menu slot — see [`OpenMenu`]. Read through the
   * per-kind selectors (`commitMenuOf`, …) rather than narrowing inline. */
  menu: OpenMenu | null;
  recoveryOpen: boolean;
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
  createBranchOpen: boolean;
  createBranchStart: string | null;
  /** Prefill for the create-branch dialog's name input (the navigator's
   * "Create branch <query>" empty-state action). Cleared when the dialog closes. */
  createBranchName: string | null;
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

  /** Which center view the toolbar tabs select: the history graph, the changes
   * (staging/review) view, or the PR list + detail. Transient — every repo
   * starts on history (see `onRepoSwitched`), so it never persists. */
  leftTab: LeftTab;

  /** Which tab the right inspector panel shows: the contextual details
   * (commit/working inspector) or the repository Files browser. Transient like
   * `leftTab` — every repo starts on details. */
  rightTab: RightTab;


  prFilter: PrFilter;
  prSelected: number | null;
  prTab: "info" | "diff" | "checks" | "commits";
  /** The "New pull request" modal raised from the PR list header. */
  createPrOpen: boolean;
  /** Exact dialog lifetime. Incremented on every open/close and repo switch so
   * a deferred submission from an older instance cannot close a newer form. */
  createPrGeneration: number;
  /** Head branch the form should open a pull request for. Null means the
   * checked-out branch — the PR list's "+" and the commit modal both mean
   * that; the graph's branch menu names the branch that was right-clicked. */
  createPrHead: string | null;
  /** Changes view: false = single-file review (default), true = stacked all-files. */
  changesAll: boolean;

  /** Draft message shown by the inline composer in the Working Changes inspector. */
  commitMsg: string;
  /** The composer's message style — free-form or structured conventional
   * commit. A view preference, so it persists. */
  commitComposerMode: ComposerMode;
  /** Id of the terminal agent last used to draft a commit message, shown as the
   * active choice in the composer's Draft menu. Persists across sessions. */
  commitDraftAgent: string | null;
  /** Pending terminal-agent draft handoff. Session-only and repo-scoped. */
  agentCommitDraft: AgentCommitDraftRequest | null;

  /** Session-only review notes pinned to diff lines — the input to the "prepare
   * message for agent" flow. Never persisted (cleared on repo switch). */
  reviewNotes: ReviewNote[];
  /** The "prepare message for agent" popup, plus the diff surface(s) + branch it
   * was opened from — so it composes from those surfaces' notes against the right
   * branch. (A set, because the working review mixes staged + unstaged sources.) */
  agentMessageOpen: boolean;
  agentMessageSurfaces: string[];
  agentMessageBranch: string | null;

  /** AI actions popup (short/full description, implementation comment, …).
   *  `commits` is newest-first; `working` folds in the uncommitted WIP row. */
  aiActions: AiActionsRequest | null;

  /** Pending destructive-action confirmation modal (null = none open). */
  confirm: ConfirmRequest | null;
  /** Pending text-input modal (null = none open). */
  prompt: PromptRequest | null;
  /** Pending local-HEAD commit-message editor (null = none open). */
  editCommitMessage: EditCommitMessageRequest | null;
  /** Pending in-app GitHub sign-in modal (GL-106), null = none open. Carries the
   * initial host; the dialog owns host choice and run/progress state. */
  githubSignin: GithubSigninRequest | null;
  /** Pending native provider OAuth sign-in modal (GL-139), null = none open. */
  providerOauthSignin: ProviderOauthSigninRequest | null;
  /** Pending worktree branch hand-off modal (null = none open). */
  handoff: HandoffRequest | null;
  /** True while a hand-off move is in flight. The success path routes through
   * `loadRepo(destination)`, whose repo-switch cleanup must NOT close the
   * dialog then (it's about to show the result); any other repo switch does. */
  handoffRunning: boolean;
  /** Pending delete-branch-and-worktree modal (GL-107), null = none open. */
  deleteWorktree: DeleteWorktreeRequest | null;
  /** True while a delete-branch-and-worktree op is in flight. A store-level latch
   * (the dialog's own `inFlight` ref dies when it closes mid-run), so a reopened
   * dialog can't start a second delete racing the first on shared git state. */
  deleteWorktreeRunning: boolean;
  /** Pending bulk remove-detached-worktrees modal, null = none open. */
  removeDetached: RemoveDetachedRequest | null;
  /** True while the remove-detached sweep is in flight — a store-level latch so a
   * reopened dialog can't start a second sweep racing the first. */
  removeDetachedRunning: boolean;



  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  /** Open global Settings → Profiles, optionally queueing an editor intent
   * (new/edit) for the panel to consume. */
  openIdentitiesSettings: (intent?: IdentitiesIntent) => void;
  /** Clear the pending Profiles editor request once the panel has consumed it. */
  clearIdentitiesIntent: () => void;
  /** Open global Settings → Accounts, optionally queueing a provider whose
   * connect view the panel should land on (auth-failure "Fix authentication…"). */
  openAccountsSettings: (intent?: AccountsConnectIntent) => void;
  /** Clear the pending Accounts connect request once the panel has consumed it. */
  clearAccountsConnectIntent: () => void;
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
  /** Pin/unpin a navigator ref (key = `pinKey(kind, name)`) in the open repo.
   * No-ops when no repo is open — a pin has nowhere to belong. */
  toggleNavPin: (key: string) => void;
  /** Open the create-branch dialog with the name input prefilled (branches from
   * HEAD) — the navigator's "Create branch <query>" action. */
  openCreateBranchNamed: (name: string) => void;
  startDrag: (branch: BranchDragRef) => void;
  clearDrag: () => void;
  /** Open a menu — replaces any menu already open (the slot is exclusive). */
  openMenu: (menu: OpenMenu) => void;
  openRecovery: () => void;
  closeRecovery: () => void;
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
  closeOverlays: () => void;
  setCreateBranchOpen: (open: boolean) => void;
  openCreateBranchFrom: (start: string | null) => void;
  openStackedReview: (oid: string, title: string) => void;
  /** Open the stacked review for a commit range (base..head combined diff). */
  openRangeReview: (base: string, head: string, title: string) => void;
  /** Open the stacked review for the merged diff across a multi-commit selection. */
  openSelectionReview: (commits: string[], title: string) => void;
  closeStackedReview: () => void;

  setLeftTab: (tab: LeftTab) => void;
  setRightTab: (tab: RightTab) => void;
  /** Open the changes view from the working-tree inspector: `all` picks the
   * stacked multi-file review; otherwise the single-file diff (used when
   * focusing one file from the right-panel list). */
  openChangesView: (all?: boolean) => void;
  /** The working tree went clean (commit landed, last change discarded) — the
   * changes view has nothing left to stage or diff, so fall back to the graph
   * instead of stranding an empty "Select a file to view its diff" pane. Called
   * by the repo store wherever it publishes an empty working-changes set. */
  onWorkingTreeClean: () => void;
  /** Everything a repository switch invalidates, in one call — the single
   * definition of "this was bound to the repo that just left", including
   * dropping to the no-repo start state and the missing-repo screen (GL-108).
   * Called by the repo store at every point the displayed repo identity changes
   * — components never orchestrate this cleanup. Pass `dropRunningHandoff` where
   * the hand-off's own worktree is what went away, so its result dialog cannot
   * linger on a repo that no longer exists. */
  onRepoSwitched: (opts?: { dropRunningHandoff?: boolean }) => void;

  setPrFilter: (filter: PrFilter) => void;
  selectPr: (num: number) => void;
  setPrTab: (tab: "info" | "diff" | "checks" | "commits") => void;
  openCreatePr: (head?: string) => void;
  /** Close the current form. When `generation` is supplied, no-op unless that
   * exact dialog instance is still current. */
  closeCreatePr: (generation?: number) => void;


  /** Reveal the inline commit composer in the Working Changes inspector. */
  openCommit: () => void;
  /** Hand commit-message drafting to an AI agent and land its answer in the
   *  composer. */
  startAgentCommitDraft: (
    request: AgentCommitDraftRequest,
    instruction: string,
    agent: AcpAgent,
  ) => void;
  cancelAgentCommitDraft: () => void;
  setCommitMsg: (msg: string) => void;
  setCommitComposerMode: (mode: ComposerMode) => void;
  setCommitDraftAgent: (agentId: string | null) => void;

  /** Pin/replace a local comment on a diff line range (keyed by file + range). */
  addReviewNote: (note: Omit<ReviewNote, "id">) => void;
  removeReviewNote: (id: string) => void;
  clearReviewNotes: () => void;
  openAgentMessage: (surfaces: string[], branch: string | null) => void;
  closeAgentMessage: () => void;

  openAiActions: (scope: AiActionsRequest) => void;
  closeAiActions: () => void;

  /** Open the destructive-action confirmation modal. */
  requestConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;

  /** Open the text-input modal. */
  requestPrompt: (req: PromptRequest) => void;
  closePrompt: () => void;

  /** Open the local-HEAD commit-message editor. */
  requestEditCommitMessage: (req: EditCommitMessageRequest) => void;
  closeEditCommitMessage: () => void;

  /** Open the in-app GitHub sign-in modal for `host` (GL-106). */
  openGithubSignin: (host: string) => void;
  closeGithubSignin: () => void;

  /** Open the native provider OAuth sign-in modal (GL-139). */
  openProviderOauthSignin: (req: ProviderOauthSigninRequest) => void;
  closeProviderOauthSignin: () => void;

  /** Open the worktree hand-off modal. */
  openHandoff: (req: HandoffRequest) => void;
  closeHandoff: () => void;
  /** Flag a hand-off move as in flight (set by the dialog's run hook). */
  setHandoffRunning: (running: boolean) => void;

  /** Open the delete-branch-and-worktree modal (GL-107). */
  openDeleteWorktree: (req: DeleteWorktreeRequest) => void;
  closeDeleteWorktree: () => void;
  /** Flag a delete-branch-and-worktree op as in flight (set by the dialog's run hook). */
  setDeleteWorktreeRunning: (running: boolean) => void;

  /** Open the bulk remove-detached-worktrees modal. */
  openRemoveDetached: (req: RemoveDetachedRequest) => void;
  closeRemoveDetached: () => void;
  /** Flag the remove-detached sweep as in flight (set by the dialog's run hook). */
  setRemoveDetachedRunning: (running: boolean) => void;

  /** Legacy one-line toast. Thin forwarder into the notifications store
   *  (see store/notifications.ts) — "ok" → a success toast, "error" → a
   *  persistent, scrollable error toast with `friendlyGitError` applied. New
   *  code with a title/body/actions/progress should call `useNotifications`.
   *  Optional `retry` attaches a stranded-`index.lock` recovery action (GL-335). */
  showToast: (
    message: string,
    tone?: "ok" | "error",
    options?: { retry?: () => void | Promise<void>; repoPath?: string },
  ) => void;
  dismissToast: () => void;
}

function terminalViewPatch(
  state: Pick<UiState, "terminalViewByRepo">,
  terminalView: TerminalView,
): Pick<UiState, "terminalView" | "terminalViewByRepo"> {
  const repoPath = useRepo.getState().summary?.path;
  return {
    terminalView,
    terminalViewByRepo: repoPath
      ? { ...state.terminalViewByRepo, [repoPath]: terminalView }
      : state.terminalViewByRepo,
  };
}

// ---------------------------------------------------------------------------
// The repo-switch reset contract (GL-358).
//
// Switching repositories invalidates state across ten concerns — 41 fields,
// which `onRepoSwitched` used to enumerate in one 50-line action that had to be
// read in full to answer "does my dialog close on a switch?". Worse, four other
// sites re-did parts of it by calling `close*()` afterwards, so a "dialog
// survives a repo switch" bug could live in any of five places.
//
// Each concern now states its own reset, beside the state it clears.
// `onRepoSwitched` is the composition of them and writes nothing itself; the
// four other sites call it instead of re-deriving a subset.
// ---------------------------------------------------------------------------

/** Exactly the fields a repo switch resets. `onRepoSwitched` annotates its
 * composed patch with this, so a field dropped from a helper — or a whole helper
 * dropped from the composition — is a compile error. The per-helper `satisfies
 * Partial<UiState>` below only rejects keys that don't exist; splitting the write
 * set across ten places made the *omission* the risk worth typing against. */
type RepoSwitchReset = Pick<
  UiState,
  | "menu"
  | "draggingFrom"
  | "navOpen"
  | "leftTab"
  | "rightTab"
  | "changesAll"
  | "stackedReview"
  | "repoSettingsOpen"
  | "createBranchOpen"
  | "createBranchStart"
  | "createBranchName"
  | "onboardingOpen"
  | "recoveryOpen"
  | "createPrOpen"
  | "createPrGeneration"
  | "createPrHead"
  | "confirm"
  | "prompt"
  | "editCommitMessage"
  | "handoff"
  | "deleteWorktree"
  | "removeDetached"
  | "reviewNotes"
  | "agentMessageOpen"
  | "agentMessageSurfaces"
  | "agentMessageBranch"
  | "aiActions"
  | "histSearchOpen"
  | "histQuery"
  | "histFilter"
  | "histFilterOpen"
  | "commitMsg"
  | "agentCommitDraft"
  | "terminalView"
  | "terminalExpanded"
>;

/** Menus and the drag payload they can carry. Every one is repo-bound: a switch
 * can land after a menu opened while `open_repo` was still pending, and keeping
 * that payload would render repo A's subject against repo B's store actions. */
const resetMenus = () => ({ menu: null, draggingFrom: null }) satisfies Partial<UiState>;

/** The branch navigator. Its pins are per-repo and persist; only the dropdown
 * itself closes. */
const resetNavigator = () => ({ navOpen: false }) satisfies Partial<UiState>;

/** Where the workspace is pointed. A stacked review outranks the history tab in
 * `deriveCenterView`, so a leftover one would render the previous repo's oid
 * against the new repo. */
const resetViewRouting = () =>
  ({
    leftTab: "history",
    rightTab: "details",
    changesAll: false,
    stackedReview: null,
  }) satisfies Partial<UiState>;

/** Repo-scoped windows and their payloads. They must disappear in this same
 * transition so their component-local drafts (settings URL, branch name/base)
 * unmount before the new repository can be targeted. */
const resetRepoScopedWindows = () =>
  ({
    repoSettingsOpen: false,
    createBranchOpen: false,
    createBranchStart: null,
    createBranchName: null,
    onboardingOpen: false,
    recoveryOpen: false,
  }) satisfies Partial<UiState>;

/** The create-PR form. Its generation advances rather than resetting, so a
 * submission deferred by the old instance cannot close the next one. */
const resetPrForm = (s: UiState) =>
  ({
    createPrOpen: false,
    createPrGeneration: s.createPrGeneration + 1,
    createPrHead: null,
  }) satisfies Partial<UiState>;

/** The modal family. A hand-off intentionally switches to its destination while
 * running and keeps its result dialog — every other repo-bound worktree flow is
 * stale. `dropRunningHandoff` overrides that for the paths where the hand-off's
 * own worktree is the thing that went away. */
const resetDialogs = (s: UiState, dropRunningHandoff = false) =>
  ({
    confirm: null,
    prompt: null,
    editCommitMessage: null,
    handoff: s.handoffRunning && !dropRunningHandoff ? s.handoff : null,
    deleteWorktree: null,
    removeDetached: null,
    aiActions: null,
  }) satisfies Partial<UiState>;

/** Local review comments and the hand-to-agent composer built from them. Both
 * are pinned to the previous repo's diffs. */
const resetReviewNotes = () =>
  ({
    reviewNotes: [],
    agentMessageOpen: false,
    agentMessageSurfaces: [],
    agentMessageBranch: null,
  }) satisfies Partial<UiState>;

/** The inline commit composer. The draft belongs to the working tree that is no
 * longer on screen; an in-flight agent draft is abandoned with it. */
const resetCommitComposer = () =>
  ({ commitMsg: "", agentCommitDraft: null }) satisfies Partial<UiState>;

/** Terminal chrome only — never the PTYs, which are repo-scoped and survive.
 * The new repo's remembered chrome is restored, defaulting to hidden. */
const resetTerminalChrome = (s: UiState, activeRepoPath: string | undefined) =>
  ({
    terminalView: (activeRepoPath ? s.terminalViewByRepo[activeRepoPath] : undefined) ?? "hidden",
    terminalExpanded: false,
  }) satisfies Partial<UiState>;

/** Whether a transient layer that must own the keyboard is up — any context /
 *  action menu, or a modal dialog. App-wide shortcuts (GL-346) stand down while
 *  one is open so the layer keeps its own Escape / Enter handling. */
export function overlayOpen(state: UiState): boolean {
  return (
    state.menu !== null ||
    state.confirm !== null ||
    state.prompt !== null ||
    state.editCommitMessage !== null ||
    state.githubSignin !== null ||
    state.providerOauthSignin !== null ||
    state.handoff !== null ||
    state.deleteWorktree !== null ||
    state.removeDetached !== null ||
    state.settingsOpen ||
    state.repoSettingsOpen ||
    state.createPrOpen ||
    state.agentMessageOpen ||
    state.aiActions !== null ||
    state.createBranchOpen ||
    state.onboardingOpen ||
    state.recoveryOpen ||
    state.navOpen
  );
}

/** Attach recovery / auth actions to error toasts. Auth wins when both match
 * (an index.lock message never is an auth failure). */
function errorToastActions(
  message: string,
  options?: { retry?: () => void | Promise<void>; repoPath?: string },
): NotifyAction[] | undefined {
  if (classifyGitAuthFailure(message)) {
    return [
      {
        label: "Fix authentication…",
        onClick: () =>
          useUi.getState().openAccountsSettings(authFailureProvider(message) ?? undefined),
      },
    ];
  }
  if (classifyIndexLockFailure(message) && options?.retry && options.repoPath) {
    const { retry, repoPath } = options;
    return [
      {
        label: "Remove lock & retry",
        onClick: () => {
          void removeIndexLockAndRetry(repoPath, retry);
        },
      },
    ];
  }
  return undefined;
}

/** True once the user has moved on to another repo — recovery must not act on
 * a path that is no longer the open repo. Toasts why and stops the caller. */
function repoClosedDuringRecovery(repoPath: string, why: string): boolean {
  if (useRepo.getState().summary?.path === repoPath) return false;
  useUi.getState().showToast(why, "error");
  return true;
}

const REPO_CLOSED = "That repository is no longer open. Switch back to it, then try again.";
const REPO_CLOSED_AFTER_REMOVE =
  "Lock removed, but that repository is no longer open — switch back to retry.";

async function removeIndexLockAndRetry(
  repoPath: string,
  retry: () => void | Promise<void>,
): Promise<void> {
  const toastAgain = (message: string) =>
    useUi.getState().showToast(message, "error", { retry, repoPath });

  if (repoClosedDuringRecovery(repoPath, REPO_CLOSED)) return;
  try {
    const status = await api.inspectIndexLock(repoPath);
    if (repoClosedDuringRecovery(repoPath, REPO_CLOSED)) return;
    if (!status.present) {
      await retry();
      return;
    }
    if (!status.stale) {
      toastAgain(status.detail || "The index lock is still in use.");
      return;
    }
    await api.removeIndexLock(repoPath);
    if (repoClosedDuringRecovery(repoPath, REPO_CLOSED_AFTER_REMOVE)) return;
    await retry();
  } catch (error) {
    toastAgain(String(error));
  }
}

/** What survives a restart. Exported so the set is assertable: a slice that
 * forgets to declare a key here silently drops a user's preference, and nothing
 * else would notice (GL-357). */
export const persistedUiState = (s: UiState) => ({
        // Each slice names the keys it persists, beside the state it persists
        // them from (GL-357); what is still listed inline below belongs to the
        // concerns this file still owns.
        ...persistedAppearance(s),
        ...persistedPanelWidths(s),
        ...persistedUpdatePrefs(s),
        ...persistedGraphFilter(s),
        terminalHeight: s.terminalHeight,
        terminalBottomInset: s.terminalBottomInset,
        terminalHorizontalLayout: s.terminalHorizontalLayout,
        terminalExpanded: s.terminalExpanded,
        prFilter: s.prFilter,
        pinnedNavRefsByRepo: s.pinnedNavRefsByRepo,
        commitComposerMode: s.commitComposerMode,
        commitDraftAgent: s.commitDraftAgent,
});

/** The store: the concerns this file still owns, plus the six sliced out. */
type UiState = UiOwnState &
  AppearanceSlice &
  PanelWidthsSlice &
  UpdatePrefsSlice &
  HistorySearchSlice &
  GraphFilterSlice &
  TooltipSlice;

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
  // The six concerns nothing else in this file touches (GL-357). Each owns its
  // own state, actions, persisted keys and — where it has one — its reset.
  ...createAppearanceSlice(set),
  ...createPanelWidthsSlice(set),
  ...createUpdatePrefsSlice(set),
  ...createHistorySearchSlice(set),
  ...createGraphFilterSlice(set),
  ...createTooltipSlice(set),

  settingsOpen: false,
  settingsTab: "general",
  repoSettingsOpen: false,
  repoSettingsSection: "identity",
  identitiesIntent: null,
  accountsConnectIntent: null,
  addAccountOpen: false,
  onboardingOpen: false,

  navOpen: false,
  pinnedNavRefsByRepo: {},
  draggingFrom: null,
  menu: null,
  recoveryOpen: false,
  terminalView: "hidden",
  terminalViewByRepo: {},
  terminalHeight: 480,
  terminalBottomInset: TERMINAL_EDGE_MARGIN,
  terminalHorizontalLayout: null,
  terminalExpanded: false,
  terminalInject: null,
  createBranchOpen: false,
  createBranchStart: null,
  createBranchName: null,
  stackedReview: null,

  leftTab: "history",
  rightTab: "details",
  fileListView: FileListView.Path,

  prFilter: "open",
  prSelected: null,
  prTab: "info",
  createPrOpen: false,
  createPrGeneration: 0,
  createPrHead: null,
  changesAll: false,

  commitMsg: "",
  commitComposerMode: ComposerMode.Conventional,
  commitDraftAgent: null,
  agentCommitDraft: null,

  reviewNotes: [],
  agentMessageOpen: false,
  agentMessageSurfaces: [],
  agentMessageBranch: null,
  aiActions: null,
  confirm: null,
  prompt: null,
  editCommitMessage: null,
  githubSignin: null,
  providerOauthSignin: null,
  handoff: null,
  handoffRunning: false,
  deleteWorktree: null,
  deleteWorktreeRunning: false,
  removeDetached: null,
  removeDetachedRunning: false,

  openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
  closeSettings: () =>
    set({ settingsOpen: false, addAccountOpen: false, identitiesIntent: null, accountsConnectIntent: null }),
  openRepoSettings: (section) =>
    set((s) => ({ repoSettingsOpen: true, repoSettingsSection: section ?? s.repoSettingsSection })),
  closeRepoSettings: () => set({ repoSettingsOpen: false }),
  setRepoSettingsSection: (section) => set({ repoSettingsSection: section }),
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => set({ onboardingOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  openIdentitiesSettings: (intent) =>
    set({ settingsOpen: true, settingsTab: "identities", identitiesIntent: intent ?? null }),
  clearIdentitiesIntent: () => set((s) => (s.identitiesIntent === null ? s : { identitiesIntent: null })),
  openAccountsSettings: (intent) =>
    set({ settingsOpen: true, settingsTab: "accounts", accountsConnectIntent: intent ?? null }),
  clearAccountsConnectIntent: () =>
    set((s) => (s.accountsConnectIntent === null ? s : { accountsConnectIntent: null })),
  setAddAccountOpen: (open) => set({ addAccountOpen: open }),

  openNav: () => set({ navOpen: true }),
  closeNav: () => set((s) => (s.navOpen ? { navOpen: false } : s)),
  toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
  toggleNavPin: (key) =>
    set((s) => {
      const repoPath = useRepo.getState().summary?.path;
      if (!repoPath) return s;
      const pinned = { ...(s.pinnedNavRefsByRepo[repoPath] ?? {}) };
      if (pinned[key]) delete pinned[key];
      else pinned[key] = true;
      return { pinnedNavRefsByRepo: { ...s.pinnedNavRefsByRepo, [repoPath]: pinned } };
    }),
  openCreateBranchNamed: (name) =>
    set({ menu: null, createBranchOpen: true, createBranchStart: null, createBranchName: name }),
  startDrag: (branch) => set({ draggingFrom: branch }),
  clearDrag: () => set({ draggingFrom: null }),
  // Menus are mutually exclusive by construction: the slot holds one OpenMenu,
  // so opening any menu replaces whatever was open. Modals/overlays still clear
  // it explicitly (`menu: null`) in their own `set` patches.
  openMenu: (menu) =>
    set(menu.kind === MenuKind.Action ? { menu, draggingFrom: null } : { menu }),
  openRecovery: () => set({ menu: null, recoveryOpen: true }),
  closeRecovery: () => set({ recoveryOpen: false }),
  // Toolbar button cycles the visible terminal chrome. Hiding never kills a
  // shell — panes persist per repo so reopening restores them; a PTY dies only
  // when the user closes its tab (see `store/terminals`).
  toggleTerminal: () =>
    set((s) => {
      const view =
        s.terminalView === "hidden"
          ? "open"
          : s.terminalView === "open"
            ? "collapsed"
            : "open";
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
        terminalView:
          useRepo.getState().summary?.path === repoPath ? "hidden" : s.terminalView,
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
      terminalBottomInset: Math.max(TERMINAL_EDGE_MARGIN, Math.min(8192, Math.round(bottomInset))),
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
      terminalInject: command
        ? { text, command, repoKey, tabId }
        : { text, repoKey, tabId },
    }));
  },
  clearTerminalInject: () => set((s) => (s.terminalInject === null ? s : { terminalInject: null })),
  closeOverlays: () => set({ menu: null, draggingFrom: null }),
  setCreateBranchOpen: (open) =>
    set({
      createBranchOpen: open,
      createBranchStart: open ? get().createBranchStart : null,
      createBranchName: open ? get().createBranchName : null,
    }),
  openCreateBranchFrom: (start) => set({ menu: null, createBranchOpen: true, createBranchStart: start }),
  openStackedReview: (oid, title) => set({ menu: null, stackedReview: { oid, title } }),
  openRangeReview: (base, head, title) =>
    set({ menu: null, stackedReview: { oid: head, title, range: { base, head } } }),
  openSelectionReview: (commits, title) =>
    set({ menu: null, stackedReview: { oid: commits[0] ?? "", title, selection: commits } }),
  closeStackedReview: () => set({ stackedReview: null }),

  setLeftTab: (tab) => set((s) => (s.leftTab === tab ? s : { leftTab: tab })),
  setRightTab: (tab) => set((s) => (s.rightTab === tab ? s : { rightTab: tab })),
  openChangesView: (all = false) => set({ leftTab: "changes", changesAll: all }),
  onWorkingTreeClean: () =>
    set((s) => (s.leftTab === "changes" ? { leftTab: "history", commitMsg: "" } : { commitMsg: "" })),
  onRepoSwitched: ({ dropRunningHandoff } = {}) => {
    const activeRepoPath = useRepo.getState().summary?.path;
    set((s): RepoSwitchReset => ({
      ...resetMenus(),
      ...resetNavigator(),
      ...resetViewRouting(),
      ...resetRepoScopedWindows(),
      ...resetPrForm(s),
      ...resetDialogs(s, dropRunningHandoff),
      ...resetReviewNotes(),
      ...resetHistorySearch(),
      ...resetCommitComposer(),
      ...resetTerminalChrome(s, activeRepoPath),
    }));
  },

  setPrFilter: (filter) => {
    if (get().prFilter === filter) return;
    set({ prFilter: filter });
    // The list holds all states already, but a tab change is a deliberate user
    // action — refresh so the chosen view is current and the spinner shows.
    void usePulls.getState().loadPullRequests();
  },
  selectPr: (num) => set({ prSelected: num, prTab: "info" }),
  setPrTab: (tab) => set({ prTab: tab }),
  openCreatePr: (head) =>
    set((s) =>
      s.createPrOpen
        ? {}
        : {
            menu: null,
            createPrOpen: true,
            createPrGeneration: s.createPrGeneration + 1,
            createPrHead: head ?? null,
          },
    ),
  closeCreatePr: (generation) =>
    set((s) =>
      generation !== undefined && generation !== s.createPrGeneration
        ? {}
        : {
            createPrOpen: false,
            createPrGeneration: s.createPrGeneration + 1,
            createPrHead: null,
          },
    ),

  openCommit: () => set({ leftTab: "changes", changesAll: false, rightTab: "details" }),
  startAgentCommitDraft: (request, instruction, agent) => {
    set({ agentCommitDraft: request });
    void useRepo
      .getState()
      .acpPrompt(
        agent.command,
        request.repoPath,
        agent.model,
        agent.config,
        instruction,
        request.token,
      )
      .then((draft) => {
        // A newer request (or a cancel) supersedes this one.
        if (get().agentCommitDraft?.token !== request.token) return;
        const trimmed = draft.trim();
        if (!trimmed) {
          set({ agentCommitDraft: null });
          get().showToast("The agent returned an empty commit-message draft.", "error");
          return;
        }
        set({ agentCommitDraft: null, commitMsg: trimmed });
      })
      .catch((error: unknown) => {
        if (get().agentCommitDraft?.token !== request.token) return;
        set({ agentCommitDraft: null });
        get().showToast(
          `Could not collect the agent's commit-message draft: ${String(error)}`,
          "error",
        );
      });
  },
  cancelAgentCommitDraft: () => {
    // Clearing the banner used to leave the adapter running for up to five
    // minutes — invisible, still able to call tools. Stop has to reach it.
    const running = get().agentCommitDraft;
    set({ agentCommitDraft: null });
    if (running) void useRepo.getState().acpCancel(running.token).catch(() => {});
  },
  setCommitMsg: (msg) => set({ commitMsg: msg }),
  setCommitComposerMode: (mode) => set({ commitComposerMode: mode }),
  setCommitDraftAgent: (agentId) => set({ commitDraftAgent: agentId }),

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

  openAiActions: (scope) => set({ menu: null, aiActions: scope }),
  closeAiActions: () => set({ aiActions: null }),

  requestConfirm: (req) => set({ menu: null, confirm: req }),
  closeConfirm: () => set({ confirm: null }),

  requestPrompt: (req) => set({ menu: null, prompt: req }),
  closePrompt: () => set({ prompt: null }),

  requestEditCommitMessage: (req) => set({ menu: null, editCommitMessage: req }),
  closeEditCommitMessage: () => set({ editCommitMessage: null }),

  openGithubSignin: (host) => set({ menu: null, githubSignin: { host } }),
  closeGithubSignin: () => set((s) => (s.githubSignin === null ? s : { githubSignin: null })),

  openProviderOauthSignin: (req) => set({ menu: null, providerOauthSignin: req }),
  closeProviderOauthSignin: () =>
    set((s) => (s.providerOauthSignin === null ? s : { providerOauthSignin: null })),

  openHandoff: (req) => set({ menu: null, handoff: req }),
  // Deliberately does NOT clear `handoffRunning`: a dismissed dialog leaves the
  // move running, and the flag must hold until it settles so loadRepo's overlay
  // cleanup can tell the hand-off's own destination switch from a genuine one.
  closeHandoff: () => set((s) => (s.handoff === null ? s : { handoff: null })),
  setHandoffRunning: (running) =>
    set((s) => (s.handoffRunning === running ? s : { handoffRunning: running })),

  openDeleteWorktree: (req) => set({ menu: null, deleteWorktree: req }),
  // Deliberately does NOT clear `deleteWorktreeRunning`: a dismissed dialog leaves
  // the delete running, and the flag must hold until it settles so a reopened
  // dialog can't start a second, racing delete (mirrors handoff, GL-107).
  closeDeleteWorktree: () =>
    set((s) => (s.deleteWorktree === null ? s : { deleteWorktree: null })),
  setDeleteWorktreeRunning: (running) =>
    set((s) => (s.deleteWorktreeRunning === running ? s : { deleteWorktreeRunning: running })),

  openRemoveDetached: (req) => set({ menu: null, removeDetached: req }),
  // Like the other worktree flows, dismissing mid-run leaves the sweep running
  // (failures toast; all-ok is silent); `removeDetachedRunning` must hold until it
  // settles so a reopened dialog can't start a second, racing sweep.
  closeRemoveDetached: () =>
    set((s) => (s.removeDetached === null ? s : { removeDetached: null })),
  setRemoveDetachedRunning: (running) =>
    set((s) => (s.removeDetachedRunning === running ? s : { removeDetachedRunning: running })),

  showToast: (message, tone = "ok", options = undefined) =>
    // Errors — especially multi-line hook output — persist until dismissed and
    // render scrollable/selectable; success toasts auto-clear. `friendlyGitError`
    // rewrites raw git/hook failures into readable text (no-op otherwise).
    // Transport-auth failures (missing/refused credentials, SSH publickey, 403)
    // additionally carry a one-click path to Settings → Accounts, landed on the
    // failing host's provider — every push/pull/fetch/clone surface funnels its
    // errors through here, so this is the single place that attaches it.
    // Stranded `.git/index.lock` failures (GL-335) attach "Remove lock & retry"
    // when the caller supplies a retry callback.
    void useNotifications.getState().notify(
      tone === "error"
        ? {
            kind: "error",
            title: friendlyGitError(message),
            raw: true,
            actions: errorToastActions(message, options),
          }
        : { kind: "success", title: message },
    ),
  dismissToast: () => {
    // Legacy single-slot API → dismiss the most recent toast (not the whole
    // stack), preserving the old "hide the current notification" meaning.
    const { toasts, dismiss } = useNotifications.getState();
    const latest = toasts[toasts.length - 1];
    if (latest) dismiss(latest.id);
  },
    }),
    {
      name: "gitlane.ui",
      // Only persist user-chosen view preferences — never transient overlays
      // (menus, toasts, drag state) or repo/account data that lives elsewhere.
      partialize: persistedUiState,
    },
  ),
);

export const rowHeightFor = (density: Density) => (density === "Comfortable" ? 46 : 34);
