// Repo-scoped windows: the Repository settings window, the create-branch
// dialog, the onboarding overlay and the recovery window. All four must vanish
// on a repo switch so their component-local drafts unmount before the new
// repository can be targeted — hence one reset for the group.

import type { MenuSlice } from "./menus";
import type { SliceSet } from "./slice";

/** Sections of the repo-scoped Repository settings window — split out of the
 * global Settings modal so per-repo config (identity, remotes) is its own
 * window opened from the toolbar, not a tab under the title-bar gear. */
export type RepoSettingsSection = "identity" | "remotes";

export interface WindowsSlice {
  /** Repo-scoped Repository settings window (identity / remotes), independent of
   * the global Settings modal so both can be reasoned about separately. */
  repoSettingsOpen: boolean;
  repoSettingsSection: RepoSettingsSection;
  /** Repository-onboarding overlay (clone / init / open) raised from the tab
   * strip while a repo is already open. Transient (not persisted). */
  onboardingOpen: boolean;
  recoveryOpen: boolean;
  createBranchOpen: boolean;
  createBranchStart: string | null;
  /** Prefill for the create-branch dialog's name input (the navigator's
   * "Create branch <query>" empty-state action). Cleared when the dialog closes. */
  createBranchName: string | null;

  /** Open the repo-scoped Repository settings window (default: last section). */
  openRepoSettings: (section?: RepoSettingsSection) => void;
  closeRepoSettings: () => void;
  setRepoSettingsSection: (section: RepoSettingsSection) => void;
  /** Raise / dismiss the repository-onboarding overlay from within an open repo. */
  openOnboarding: () => void;
  closeOnboarding: () => void;
  openRecovery: () => void;
  closeRecovery: () => void;
  setCreateBranchOpen: (open: boolean) => void;
  openCreateBranchFrom: (start: string | null) => void;
  /** Open the create-branch dialog with the name input prefilled (branches from
   * HEAD) — the navigator's "Create branch <query>" action. */
  openCreateBranchNamed: (name: string) => void;
}

/** Repo-scoped windows and their payloads. They must disappear in this same
 * transition so their component-local drafts (settings URL, branch name/base)
 * unmount before the new repository can be targeted. */
export const resetRepoScopedWindows = () =>
  ({
    repoSettingsOpen: false,
    createBranchOpen: false,
    createBranchStart: null,
    createBranchName: null,
    onboardingOpen: false,
    recoveryOpen: false,
  }) satisfies Partial<WindowsSlice>;

export function createWindowsSlice(
  set: SliceSet<WindowsSlice & Pick<MenuSlice, "menu">>,
  get: () => WindowsSlice,
): WindowsSlice {
  return {
    ...resetRepoScopedWindows(),
    repoSettingsSection: "identity",

    openRepoSettings: (section) =>
      set((s) => ({ repoSettingsOpen: true, repoSettingsSection: section ?? s.repoSettingsSection })),
    closeRepoSettings: () => set({ repoSettingsOpen: false }),
    setRepoSettingsSection: (section) => set({ repoSettingsSection: section }),
    openOnboarding: () => set({ onboardingOpen: true }),
    closeOnboarding: () => set({ onboardingOpen: false }),
    openRecovery: () => set({ menu: null, recoveryOpen: true }),
    closeRecovery: () => set({ recoveryOpen: false }),
    setCreateBranchOpen: (open) =>
      set({
        createBranchOpen: open,
        createBranchStart: open ? get().createBranchStart : null,
        createBranchName: open ? get().createBranchName : null,
      }),
    openCreateBranchFrom: (start) =>
      set({ menu: null, createBranchOpen: true, createBranchStart: start }),
    openCreateBranchNamed: (name) =>
      set({ menu: null, createBranchOpen: true, createBranchStart: null, createBranchName: name }),
  };
}
