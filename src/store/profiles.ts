// Git-profile state: the user's saved, reusable commit identities and how they
// apply to the open repo. Split from `accounts.ts` because profiles are a
// distinct concern — Tier 1 (commit/fetch/push work with just a profile, no
// provider account). Applying a profile writes name/email/signing into the
// repo's *local* git config via the shared identity command; the bound PR
// account (Tier 2) stays in `accounts.ts`. The repo's "current" applied profile
// is derived from the local-config identity (`accounts.repoIdentity`) rather
// than stored, so git config remains the source of truth.

import { create } from "zustand";

import { api, type RepoIdentity } from "../lib/api";
import { ACCOUNT_COLORS } from "../lib/palette";
import { type GitProfile, type ProfileDraft, selectProfile } from "../lib/profiles";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import { useUi } from "./ui";

export type { GitProfile, ProfileDraft } from "../lib/profiles";

// All non-secret app metadata (signing fields are key ids/paths, never private
// material), so localStorage is the right tier per GL-48.
const LS_PROFILES = "gitlane.profiles";
// Custom commit emails the user pinned per repo+profile. Keeping the override
// keyed by *both* repo and profile is the fix for the switch-away-and-back
// regression: re-applying a profile restores the email you edited, instead of
// silently overwriting it with the profile default.
const LS_CUSTOM_EMAIL = "gitlane.repoProfileEmail";
// The profile explicitly applied to a repo, by stable id: { [repoPath]: id }.
// This is the source of truth for "which profile is selected" so duplicate git
// names and custom emails never make the panel show/mutate the wrong profile.
const LS_REPO_PROFILE = "gitlane.repoProfile";

function readJsonMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}
function writeJsonMap<T>(key: string, map: Record<string, T>) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* ignore quota / unavailable */
  }
}

function readProfiles(): GitProfile[] {
  try {
    const raw = localStorage.getItem(LS_PROFILES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GitProfile[]) : [];
  } catch {
    return [];
  }
}
function writeProfiles(profiles: GitProfile[]) {
  try {
    localStorage.setItem(LS_PROFILES, JSON.stringify(profiles));
  } catch {
    /* ignore */
  }
}

// Custom-email overrides: { [repoPath]: { [profileId]: email } }.
const readOverrides = () => readJsonMap<Record<string, string>>(LS_CUSTOM_EMAIL);
function customEmail(path: string, profileId: string): string | null {
  return readOverrides()[path]?.[profileId] ?? null;
}
function setCustomEmailEntry(path: string, profileId: string, email: string | null) {
  const all = readOverrides();
  const repo = { ...(all[path] ?? {}) };
  if (email === null) delete repo[profileId];
  else repo[profileId] = email;
  if (Object.keys(repo).length === 0) delete all[path];
  else all[path] = repo;
  writeJsonMap(LS_CUSTOM_EMAIL, all);
}

// Applied-profile-id persistence (the unambiguous "which profile" signal).
const readAppliedIds = () => readJsonMap<string>(LS_REPO_PROFILE);
/** The profile id explicitly applied to a repo, or null (none / default). */
export function appliedProfileId(path: string): string | null {
  return readAppliedIds()[path] ?? null;
}
function setAppliedProfileId(path: string, id: string | null) {
  const all = readAppliedIds();
  if (id === null) delete all[path];
  else all[path] = id;
  writeJsonMap(LS_REPO_PROFILE, all);
}

/** Signing args for `api.setRepoIdentity`. Empty strings unset the key/format
 * so applying a no-signing profile clears any signing a prior one left behind;
 * `false` writes `commit.gpgsign false` so signing is explicitly off. */
function signingArgs(profile: GitProfile) {
  return {
    signingKey: profile.signingKey ?? "",
    gpgFormat: profile.gpgFormat ?? "",
    gpgSign: profile.gpgSign ?? false,
    tagGpgSign: profile.tagGpgSign ?? false,
  };
}

function repoPath(): string | null {
  return useRepo.getState().summary?.path ?? null;
}

interface ProfilesState {
  profiles: GitProfile[];
  /** The global git identity, shown by the "Default git identity" option. */
  defaultIdentity: RepoIdentity | null;

  /** Load saved profiles from localStorage (call once on mount). */
  loadProfiles: () => void;
  /** Load the global git identity for the Default option. */
  loadDefaultIdentity: () => Promise<void>;
  /** Create (no `id`) or update (with `id`) a profile; persists. Returns the
   * saved profile (with its generated id) so callers can apply it. */
  saveProfile: (draft: ProfileDraft) => GitProfile;
  /** Delete a profile by id; persists. Does not touch any repo's config. */
  deleteProfile: (id: string) => void;
  /** Mark a profile the default-for-new-repos (clears the flag on others). */
  setDefaultProfile: (id: string) => void;
  /** Apply a profile (or `null` = Default git identity) to the open repo:
   * writes local git config, restoring any saved custom email for this pair. */
  applyProfile: (id: string | null) => Promise<void>;
  /** Override the applied profile's commit email for this repo (persisted). */
  setCustomEmail: (email: string) => Promise<void>;
  /** Drop the per-repo custom email and re-apply the profile's own email. */
  resetCustomEmail: () => Promise<void>;
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  profiles: [],
  defaultIdentity: null,

  loadProfiles: () => set({ profiles: readProfiles() }),

  loadDefaultIdentity: async () => {
    try {
      const id = await api.defaultGitIdentity();
      set({ defaultIdentity: id });
    } catch {
      set({ defaultIdentity: null });
    }
  },

  saveProfile: (draft) => {
    const profiles = [...get().profiles];
    let saved: GitProfile;
    if (draft.id) {
      const i = profiles.findIndex((p) => p.id === draft.id);
      saved = { ...profiles[i], ...draft, id: draft.id };
      if (i >= 0) profiles[i] = saved;
    } else {
      saved = {
        ...draft,
        id: crypto.randomUUID(),
        color: ACCOUNT_COLORS[profiles.length % ACCOUNT_COLORS.length],
        // The first profile created becomes the default-for-new-repos.
        isDefault: profiles.length === 0,
      };
      profiles.push(saved);
    }
    writeProfiles(profiles);
    set({ profiles });
    return saved;
  },

  deleteProfile: (id) => {
    const profiles = get().profiles.filter((p) => p.id !== id);
    // Keep a default designated if any remain.
    if (profiles.length > 0 && !profiles.some((p) => p.isDefault)) {
      profiles[0] = { ...profiles[0], isDefault: true };
    }
    writeProfiles(profiles);
    set({ profiles });
  },

  setDefaultProfile: (id) => {
    const profiles = get().profiles.map((p) => ({ ...p, isDefault: p.id === id }));
    writeProfiles(profiles);
    set({ profiles });
  },

  applyProfile: async (id) => {
    const path = repoPath();
    if (!path) return;
    if (id === null) {
      try {
        await api.clearRepoIdentity(path);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
        return;
      }
      // Default git identity → no profile applied.
      setAppliedProfileId(path, null);
      await useAccounts.getState().hydrateRepoIdentity(path);
      useUi.getState().showToast("Using the default git identity for this repo");
      return;
    }
    const profile = get().profiles.find((p) => p.id === id);
    if (!profile) return;
    const email = customEmail(path, id) ?? profile.email;
    try {
      await api.setRepoIdentity(path, profile.name, email, signingArgs(profile));
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return;
    }
    // Record the applied profile by id so selection stays unambiguous.
    setAppliedProfileId(path, id);
    await useAccounts.getState().hydrateRepoIdentity(path);
    useUi.getState().showToast(`This repo commits as ${profile.label}`);
  },

  setCustomEmail: async (email) => {
    const path = repoPath();
    if (!path) return;
    const sel = selectProfile(useAccounts.getState().repoIdentity, get().profiles, appliedProfileId(path));
    if (sel.kind !== "profile") return;
    const profile = get().profiles.find((p) => p.id === sel.id);
    if (!profile) return;
    try {
      await api.setRepoIdentity(path, profile.name, email, signingArgs(profile));
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return;
    }
    // Cache the override only after git config actually accepted it, so a failed
    // write is never re-applied when the user later switches back to this profile.
    setCustomEmailEntry(path, sel.id, email);
    await useAccounts.getState().hydrateRepoIdentity(path);
  },

  resetCustomEmail: async () => {
    const path = repoPath();
    if (!path) return;
    const sel = selectProfile(useAccounts.getState().repoIdentity, get().profiles, appliedProfileId(path));
    if (sel.kind !== "profile") return;
    setCustomEmailEntry(path, sel.id, null);
    await get().applyProfile(sel.id);
  },
}));
