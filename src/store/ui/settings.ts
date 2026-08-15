// The global Settings modal and the one-shot editor intents repo-scoped
// surfaces hand it. Survives a repo switch — the repo-scoped windows in
// `windows.ts` do not.

import type { ForgeAuthProvider } from "@/lib/api";
import type { SliceSet } from "./slice";

export type SettingsTab =
  | "general"
  | "accounts"
  | "identities"
  | "agents"
  | "terminal"
  | "prompts"
  | "shortcuts"
  | "about";

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

export interface SettingsSlice {
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** Pending Settings → Profiles editor request (transient, consumed on mount). */
  identitiesIntent: IdentitiesIntent | null;
  accountsConnectIntent: AccountsConnectIntent | null;
  addAccountOpen: boolean;

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
  setAddAccountOpen: (open: boolean) => void;
}

/** The global Settings modal owns the keyboard while it is up. */
export const overlayOpenSettings = (s: SettingsSlice) => s.settingsOpen;

export function createSettingsSlice(set: SliceSet<SettingsSlice>): SettingsSlice {
  return {
    settingsOpen: false,
    settingsTab: "general",
    identitiesIntent: null,
    accountsConnectIntent: null,
    addAccountOpen: false,

    openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
    closeSettings: () =>
      set({
        settingsOpen: false,
        addAccountOpen: false,
        identitiesIntent: null,
        accountsConnectIntent: null,
      }),
    setSettingsTab: (tab) => set({ settingsTab: tab }),
    openIdentitiesSettings: (intent) =>
      set({ settingsOpen: true, settingsTab: "identities", identitiesIntent: intent ?? null }),
    clearIdentitiesIntent: () =>
      set((s) => (s.identitiesIntent === null ? s : { identitiesIntent: null })),
    openAccountsSettings: (intent) =>
      set({ settingsOpen: true, settingsTab: "accounts", accountsConnectIntent: intent ?? null }),
    clearAccountsConnectIntent: () =>
      set((s) => (s.accountsConnectIntent === null ? s : { accountsConnectIntent: null })),
    setAddAccountOpen: (open) => set({ addAccountOpen: open }),
  };
}
