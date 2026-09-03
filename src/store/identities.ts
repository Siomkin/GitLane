// Commit-identity state (GL-130, flattened): the user's saved identity cards
// (name + email + optional signing — the old git profiles) and how one
// applies to the open repo. Connected accounts are NOT involved here: they
// exist for auth (per remote, in `accounts.ts`) and only contribute a prefill
// when creating a card. Applying a card writes the repo's *local* git config
// via the shared identity command; the repo's "current" card is derived from
// the local-config identity (`accounts.repoIdentity`) rather than stored, so
// git config remains the source of truth.
//
// Persistence:
// - `gitlane.profiles:v1` — the identity cards, migrated once from the
//   legacy-named unversioned key.
// - `gitlane.repoCommitSource` `{ [repoKey]: {kind:"manual", id} }` — the
//   applied card, migrated from `gitlane.repoProfile` on first load.
//
// Per-repo entries key on the repository identity (`repoIdentityKey`, the main
// checkout's path) so all worktrees of a repo share them — the old store keyed
// by worktree path; entries migrate lazily as each repo opens (GL-109 pattern).

import { create } from "zustand";

import { api, type RepoIdentity } from "@/lib/api";
import { type CommitSourceRef } from "@/lib/identities";
import { ACCOUNT_COLORS } from "@/lib/palette";
import { type GitProfile, type ProfileDraft } from "@/lib/profiles";
import { migratePathKey } from "@/lib/worktrees";
import { useAccounts } from "./accounts";
import { useUi } from "./ui";
import {
  currentPathForIdentity,
  LS_COMMIT_SOURCE,
  migrateLegacyStorage,
  openRepoKeys,
  readAppliedMap,
  readManuals,
  writeJsonMap,
  writeManuals,
} from "./identities/storage";
import {
  activeIdentityIntents,
  invalidateDeletedIdentity,
  isLatestIdentityWrite,
  nextIdentityWrite,
  queueIdentityWrite,
} from "./identities/writeQueue";

export type { GitProfile as ManualIdentity, ProfileDraft as ManualIdentityDraft } from "@/lib/profiles";
export type { CommitSourceRef } from "@/lib/identities";

// Applied-card persistence (the unambiguous "which card" signal).
function readApplied(key: string, path: string): CommitSourceRef | null {
  const all = readAppliedMap();
  if (migratePathKey(all, key, path)) writeJsonMap(LS_COMMIT_SOURCE, all);
  return all[key] ?? null;
}
function writeApplied(key: string, ref: CommitSourceRef | null) {
  const all = readAppliedMap();
  if (ref === null) delete all[key];
  else all[key] = ref;
  writeJsonMap(LS_COMMIT_SOURCE, all);
}

/** The applied identity card for the open repo, or null (this computer). */
export function appliedCommitSource(): CommitSourceRef | null {
  const keys = openRepoKeys();
  if (!keys) return null;
  return readApplied(keys.key, keys.path);
}

/** Carry a relocated repo's per-path identity entries (GL-108 Locate…). An
 * entry already stored for the new path wins; the stale path's entries are
 * dropped either way. The applied config itself lives in the repo's local git
 * config and moved with the folder. */
export function migrateIdentityBindings(fromPath: string, toPath: string) {
  const applied = readAppliedMap();
  if (applied[fromPath] !== undefined && applied[toPath] === undefined) {
    applied[toPath] = applied[fromPath];
  }
  delete applied[fromPath];
  writeJsonMap(LS_COMMIT_SOURCE, applied);
}

/** Remove every reference to a deleted card from the per-repo maps, so a
 * stale id can't reselect a wrong duplicate. */
function scrubManualId(id: string) {
  const applied = readAppliedMap();
  let appliedChanged = false;
  for (const key of Object.keys(applied)) {
    if (applied[key].id === id) {
      delete applied[key];
      appliedChanged = true;
    }
  }
  if (appliedChanged) writeJsonMap(LS_COMMIT_SOURCE, applied);
}

/** Signing args for `api.setRepoIdentity`. Empty strings unset the key/format
 * so applying a no-signing card clears any signing a prior one left behind;
 * `false` writes `commit.gpgsign false` so signing is explicitly off. */
function signingArgs(card: Pick<GitProfile, "signingKey" | "gpgFormat" | "gpgSign" | "tagGpgSign">) {
  return {
    signingKey: card.signingKey ?? "",
    gpgFormat: card.gpgFormat ?? "",
    gpgSign: card.gpgSign ?? false,
    tagGpgSign: card.tagGpgSign ?? false,
  };
}

/** The identity git config holds after applying a card — shaped to match what
 * `repo_identity` reads back, so the optimistic pin agrees with the
 * reconcile. */
function expectedIdentity(
  card: Pick<GitProfile, "signingKey" | "gpgFormat" | "gpgSign" | "tagGpgSign">,
  name: string,
  email: string,
): RepoIdentity {
  return {
    name,
    email,
    signingKey: card.signingKey || undefined,
    gpgFormat: card.gpgFormat || undefined,
    gpgSign: card.gpgSign ?? false,
    tagGpgSign: card.tagGpgSign ?? false,
  };
}

interface IdentitiesState {
  /** Saved identity cards (the old git profiles; same storage). */
  manualIdentities: GitProfile[];
  /** The global git identity, shown by the "This computer" option. */
  defaultIdentity: RepoIdentity | null;

  /** Load cards from localStorage, running the one-shot pre-GL-130 storage
   * migration first (call once on mount). */
  loadIdentities: () => void;
  /** Load the global git identity for the "This computer" option. */
  loadDefaultIdentity: () => Promise<void>;
  /** Create (no `id`) or update (with `id`) a card; persists. Returns the
   * saved card (with its generated id) so callers can apply it. */
  saveManualIdentity: (draft: ProfileDraft) => GitProfile;
  /** Delete a card by id; persists. Does not touch any repo's config. */
  deleteManualIdentity: (id: string) => void;
  /** Mark a card the suggested default (clears the flag on others). */
  setDefaultManualIdentity: (id: string) => void;
  /** Apply a card (or `null` = this computer) to the open repo: writes local
   * git config. */
  /** Returns whether the git-config write and reconciliation succeeded, so
   * repo-scoped pickers can keep failed selections visibly inactive. */
  applyCommitSource: (ref: CommitSourceRef | null) => Promise<boolean>;
}

export const useIdentities = create<IdentitiesState>((set, get) => ({
  manualIdentities: [],
  defaultIdentity: null,

  loadIdentities: () => {
    migrateLegacyStorage();
    set({ manualIdentities: readManuals() });
  },

  loadDefaultIdentity: async () => {
    try {
      const id = await api.defaultGitIdentity();
      set({ defaultIdentity: id });
    } catch {
      set({ defaultIdentity: null });
    }
  },

  saveManualIdentity: (draft) => {
    const manuals = [...get().manualIdentities];
    const index = draft.id ? manuals.findIndex((p) => p.id === draft.id) : -1;
    let saved: GitProfile;
    if (index >= 0) {
      saved = { ...manuals[index], ...draft, id: draft.id! };
      manuals[index] = saved;
    } else {
      // No id, or an id that no longer exists → create (never silently drop).
      saved = {
        ...draft,
        id: draft.id ?? crypto.randomUUID(),
        color: ACCOUNT_COLORS[manuals.length % ACCOUNT_COLORS.length],
        // The first card created becomes the suggested default.
        isDefault: manuals.length === 0,
      };
      manuals.push(saved);
    }
    writeManuals(manuals);
    set({ manualIdentities: manuals });
    return saved;
  },

  deleteManualIdentity: (id) => {
    const manuals = get().manualIdentities.filter((p) => p.id !== id);
    // Keep a default designated if any remain.
    if (manuals.length > 0 && !manuals.some((p) => p.isDefault)) {
      manuals[0] = { ...manuals[0], isDefault: true };
    }
    writeManuals(manuals);
    // An apply may already be queued or waiting on IPC. Make it ineligible to
    // publish UI state/toasts, and let its queue closure re-check existence
    // before both the config write and applied-card persistence.
    invalidateDeletedIdentity(id);
    // Drop the deleted id from per-repo applied maps so selection can't fall
    // back to a wrong duplicate.
    scrubManualId(id);
    set({ manualIdentities: manuals });
  },

  setDefaultManualIdentity: (id) => {
    const manuals = get().manualIdentities.map((p) => ({ ...p, isDefault: p.id === id }));
    writeManuals(manuals);
    set({ manualIdentities: manuals });
  },

  applyCommitSource: async (ref) => {
    const keys = openRepoKeys();
    if (!keys) return false;
    const { key, path } = keys;

    // Capture the card before the first await. An edit/delete while this write
    // is queued must not mutate the tuple Git receives halfway through.
    const card = ref === null ? null : get().manualIdentities.find((p) => p.id === ref.id);
    if (ref !== null && !card) return false;
    const generation = nextIdentityWrite(key, ref);

    try {
      if (ref === null) {
        try {
          await queueIdentityWrite(key, async () => {
            await api.clearRepoIdentity(path);
            // Persist in the same serialized turn as the durable config write.
            // A newer queued failure then leaves this last successful state as
            // the source of truth instead of the pre-queue marker.
            writeApplied(key, null);
          });
        } catch (e) {
          if (isLatestIdentityWrite(key, generation)) {
            const currentPath = currentPathForIdentity(key);
            if (currentPath) await useAccounts.getState().hydrateRepoIdentity(currentPath);
            if (isLatestIdentityWrite(key, generation)) {
              useUi.getState().showToast(e, "error");
            }
          }
          return false;
        }
        if (!isLatestIdentityWrite(key, generation)) return true;
        // The git write already succeeded, so report success even if the user
        // switched repos before we could reconcile the (now-irrelevant) view state.
        const currentPath = currentPathForIdentity(key);
        if (!currentPath) return true;
        // Publish the cleared identity immediately so a commit in the reconcile
        // window doesn't pin the previous card's author.
        useAccounts.getState().pinRepoIdentity(null, currentPath);
        // Best-effort reconcile: the git-config write already succeeded, so a
        // hydrate failure must not turn this into a reported failure.
        try {
          await useAccounts.getState().hydrateRepoIdentity(currentPath);
        } catch {
          /* leave the optimistic pin in place until the next repo read */
        }
        return true;
      }

      // Narrowed above alongside the intent capture.
      if (!card) return false;
      const email = card.email;
      const cardStillExists = () => get().manualIdentities.some((candidate) => candidate.id === card.id);

      let outcome: "skipped" | "applied" | "deletedAfterWrite" = "skipped";
      try {
        outcome = await queueIdentityWrite(key, async () => {
          if (!cardStillExists()) return "skipped" as const;
          await api.setRepoIdentity(path, card.name, email, signingArgs(card));
          if (!cardStillExists()) return "deletedAfterWrite" as const;
          // Keep durable config and the disambiguating card id ordered together.
          writeApplied(key, ref);
          return "applied" as const;
        });
      } catch (e) {
        if (isLatestIdentityWrite(key, generation)) {
          const currentPath = currentPathForIdentity(key);
          if (currentPath) await useAccounts.getState().hydrateRepoIdentity(currentPath);
          if (isLatestIdentityWrite(key, generation)) {
            useUi.getState().showToast(e, "error");
          }
        }
        return false;
      }
      if (outcome === "skipped") return false;
      if (outcome === "deletedAfterWrite") {
        // The external write cannot be canceled once IPC is running. Reconcile
        // the now-unmanaged local identity immediately, but never restore the
        // deleted card's marker (errors still toast; routine apply is silent).
        const currentPath = currentPathForIdentity(key);
        if (currentPath) await useAccounts.getState().hydrateRepoIdentity(currentPath);
        return false;
      }
      if (!isLatestIdentityWrite(key, generation)) return true;
      const currentPath = currentPathForIdentity(key);
      if (!currentPath) return true; // write succeeded (see above)
      useAccounts
        .getState()
        .pinRepoIdentity(expectedIdentity(card, card.name, email), currentPath);
      try {
        await useAccounts.getState().hydrateRepoIdentity(currentPath);
      } catch {
        /* best-effort: the git-config write already succeeded */
      }
      return true;
    } finally {
      if (activeIdentityIntents.get(key)?.generation === generation) {
        activeIdentityIntents.delete(key);
      }
    }
  },

}));
