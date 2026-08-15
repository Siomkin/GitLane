// The modal family: every pending request that renders as an in-app dialog,
// plus the run latches the worktree flows keep across a dismissal.
//
// One slice because they share a reset (`resetDialogs`) and a rule — opening any
// of them closes the menu that raised it.

import type { AiActionScope } from "@/features/agents/ai-actions/aiActions";
import type { ForgeAuthProvider, WorktreeInfo } from "@/lib/api";
import type { MenuSlice } from "./menus";
import type { SliceSet } from "./slice";

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

/** A pending text-input prompt (rename branch, tag name, squash message, …).
 * Rendered as an in-app modal — native `window.prompt` is unreliable in the
 * Tauri webview. */
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

export interface DialogsSlice {
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
}

/** The modal family. A hand-off intentionally switches to its destination while
 * running and keeps its result dialog — every other repo-bound worktree flow is
 * stale. `dropRunningHandoff` overrides that for the paths where the hand-off's
 * own worktree is the thing that went away. */
export const resetDialogs = (
  s: Pick<DialogsSlice, "handoff" | "handoffRunning">,
  dropRunningHandoff = false,
) =>
  ({
    confirm: null,
    prompt: null,
    editCommitMessage: null,
    handoff: s.handoffRunning && !dropRunningHandoff ? s.handoff : null,
    deleteWorktree: null,
    removeDetached: null,
    aiActions: null,
  }) satisfies Partial<DialogsSlice>;

/** Any modal in this family owns the keyboard — confirm / prompt / edit-commit,
 *  AI actions, worktree flows, and the GitHub / provider OAuth sign-in slots
 *  (those live here, not a fake accounts slice). */
export const overlayOpenDialogs = (s: DialogsSlice) =>
  s.confirm !== null ||
  s.prompt !== null ||
  s.editCommitMessage !== null ||
  s.githubSignin !== null ||
  s.providerOauthSignin !== null ||
  s.handoff !== null ||
  s.deleteWorktree !== null ||
  s.removeDetached !== null ||
  s.aiActions !== null;

export function createDialogsSlice(
  set: SliceSet<DialogsSlice & Pick<MenuSlice, "menu">>,
): DialogsSlice {
  return {
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
  };
}
