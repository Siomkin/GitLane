// Cross-cutting UI state that isn't repository data: theme + density, the
// settings modal, transient overlays (toast, drag action menu, context menu,
// create-branch dialog) and the pull-request view selection. Kept separate
// from `useRepo` so view chrome never re-renders on git data churn.
//
// This file is the facade (GL-357/GL-358): every concern lives in `ui/`, and
// what stays here is only what no single slice can own — the composed `UiState`,
// the repo-switch reset contract, `overlayOpen`, and what persists. Public types
// are re-exported so importers keep one import site.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { useRepo } from "./repo";
import type { AccentColor } from "@/lib/accent";
import {
  createAppearanceSlice,
  persistedAppearance,
  type AppearanceSlice,
} from "./ui/appearance";
import { createComposerSlice, persistedComposer, resetCommitComposer, type ComposerSlice } from "./ui/composer";
import { createDialogsSlice, overlayOpenDialogs, resetDialogs, type DialogsSlice } from "./ui/dialogs";
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
import { createMenuSlice, overlayOpenMenus, resetMenus, type MenuSlice } from "./ui/menus";
import {
  createNavigatorSlice,
  overlayOpenNavigator,
  persistedNavigator,
  resetNavigator,
  type NavigatorSlice,
} from "./ui/navigator";
import {
  createPanelWidthsSlice,
  persistedPanelWidths,
  type PanelWidthsSlice,
} from "./ui/panels";
import { createPrViewSlice, overlayOpenPrView, persistedPrView, resetPrForm, type PrViewSlice } from "./ui/prView";
import { createReviewNotesSlice, overlayOpenReviewNotes, resetReviewNotes, type ReviewNotesSlice } from "./ui/reviewNotes";
import { createSettingsSlice, overlayOpenSettings, type SettingsSlice } from "./ui/settings";
import {
  createTerminalChromeSlice,
  persistedTerminalChrome,
  resetTerminalChrome,
  type TerminalChromeSlice,
} from "./ui/terminalChrome";
import { createToastSlice, type ToastSlice } from "./ui/toasts";
import { createTooltipSlice, type TooltipSlice } from "./ui/tooltip";
import {
  createUpdatePrefsSlice,
  persistedUpdatePrefs,
  type UpdatePrefsSlice,
} from "./ui/updatePrefs";
import { createViewRoutingSlice, resetViewRouting, type ViewRoutingSlice } from "./ui/viewRouting";
import { createWindowsSlice, overlayOpenWindows, resetRepoScopedWindows, type WindowsSlice } from "./ui/windows";

export type { AccentColor };
// Every concern lives under `ui/`; their public types are re-exported here so
// importers keep one import site.
export type { Density, Theme } from "./ui/appearance";
import type { Density } from "./ui/appearance";
export type { HistFilter } from "./ui/historySearch";
export {
  AUTO_FETCH_MINUTES,
  DEFAULT_AUTO_FETCH_MINUTES,
  sanitizeAutoFetchMinutes,
  type AutoFetchMinutes,
} from "./ui/updatePrefs";
export {
  FileMenuKind,
  MenuKind,
  actionMenuOf,
  commitMenuOf,
  contextMenuOf,
  fileMenuOf,
  stashMenuOf,
  tagMenuOf,
  wipMenuOf,
  worktreeMenuOf,
  type ActionMenu,
  type CommitMenu,
  type ContextMenu,
  type FileMenu,
  type OpenMenu,
  type StashMenu,
  type TagMenu,
  type WipMenu,
  type WorktreeMenu,
} from "./ui/menus";
export type {
  AiActionsRequest,
  ConfirmRequest,
  DeleteWorktreeRequest,
  EditCommitMessageRequest,
  GithubSigninRequest,
  HandoffRequest,
  PromptOption,
  PromptRequest,
  ProviderOauthSigninRequest,
  RemoveDetachedRequest,
} from "./ui/dialogs";
export type { AgentCommitDraftRequest } from "./ui/composer";
export type { ReviewNote } from "./ui/reviewNotes";
export type {
  AccountsConnectIntent,
  IdentitiesIntent,
  ProfilePrefill,
  SettingsTab,
} from "./ui/settings";
export type { RepoSettingsSection } from "./ui/windows";
export type { TerminalView } from "./ui/terminalChrome";
/** Re-exported so the draft action's signature has one import site. */
export type { AcpAgent } from "@/lib/api";
// Re-exported so existing `store/ui` importers keep one import site; the union
// itself is defined in lib/prs.ts (single source of truth).
export type { PrFilter } from "@/lib/prs";

/** What no slice owns: the repo-switch transition every concern contributes to. */
interface UiTransitions {
  /** Everything a repository switch invalidates, in one call — the single
   * definition of "this was bound to the repo that just left", including
   * dropping to the no-repo start state and the missing-repo screen (GL-108).
   * Called by the repo store at every point the displayed repo identity changes
   * — components never orchestrate this cleanup. Pass `dropRunningHandoff` where
   * the hand-off's own worktree is what went away, so its result dialog cannot
   * linger on a repo that no longer exists. */
  onRepoSwitched: (opts?: { dropRunningHandoff?: boolean }) => void;
}

/** The store: one type per concern, composed. */
type UiState = UiTransitions &
  AppearanceSlice &
  ComposerSlice &
  DialogsSlice &
  GraphFilterSlice &
  HistorySearchSlice &
  MenuSlice &
  NavigatorSlice &
  PanelWidthsSlice &
  PrViewSlice &
  ReviewNotesSlice &
  SettingsSlice &
  TerminalChromeSlice &
  ToastSlice &
  TooltipSlice &
  UpdatePrefsSlice &
  ViewRoutingSlice &
  WindowsSlice;

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
 * Partial<…>` in each slice only rejects keys that don't exist; splitting the
 * write set across ten places made the *omission* the risk worth typing against. */
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

/** Whether a transient layer that must own the keyboard is up — any context /
 *  action menu, or a modal dialog. App-wide shortcuts (GL-346) stand down while
 *  one is open so the layer keeps its own Escape / Enter handling. Each slice
 *  names the layers it owns, beside the state they read (GL-377) — a new dialog
 *  that must own the keyboard is declared next to its field, not remembered here. */
export function overlayOpen(state: UiState): boolean {
  return (
    overlayOpenMenus(state) ||
    overlayOpenDialogs(state) ||
    overlayOpenWindows(state) ||
    overlayOpenNavigator(state) ||
    overlayOpenSettings(state) ||
    overlayOpenPrView(state) ||
    overlayOpenReviewNotes(state)
  );
}

/** What survives a restart. Exported so the set is assertable: a slice that
 * forgets to declare a key here silently drops a user's preference, and nothing
 * else would notice (GL-357). Each slice names the keys it persists, beside the
 * state it persists them from. */
export const persistedUiState = (s: UiState) => ({
  ...persistedAppearance(s),
  ...persistedPanelWidths(s),
  ...persistedUpdatePrefs(s),
  ...persistedGraphFilter(s),
  ...persistedTerminalChrome(s),
  ...persistedPrView(s),
  ...persistedNavigator(s),
  ...persistedComposer(s),
});

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      // One spread per concern. Each owns its own state, actions, persisted keys
      // and — where it has one — its reset.
      ...createAppearanceSlice(set),
      ...createPanelWidthsSlice(set),
      ...createUpdatePrefsSlice(set),
      ...createHistorySearchSlice(set),
      ...createGraphFilterSlice(set),
      ...createTooltipSlice(set),
      ...createMenuSlice(set),
      ...createNavigatorSlice(set),
      ...createTerminalChromeSlice(set),
      ...createSettingsSlice(set),
      ...createWindowsSlice(set, get),
      ...createViewRoutingSlice(set),
      ...createPrViewSlice(set, get),
      ...createComposerSlice(set, get),
      ...createReviewNotesSlice(set),
      ...createDialogsSlice(set),
      ...createToastSlice(get),

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
