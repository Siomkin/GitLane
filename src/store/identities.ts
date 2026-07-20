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
import { z } from "zod";

import { api, type RepoIdentity } from "@/lib/api";
import {
  migrateAppliedProfileMap,
  type CommitSourceRef,
} from "@/lib/identities";
import { ACCOUNT_COLORS } from "@/lib/palette";
import { isValidEmail, type GitProfile, type ProfileDraft } from "@/lib/profiles";
import { readMigratedStorage } from "@/lib/storage";
import { migratePathKey, repoIdentityKey } from "@/lib/worktrees";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import { useUi } from "./ui";

export type { GitProfile as ManualIdentity, ProfileDraft as ManualIdentityDraft } from "@/lib/profiles";
export type { CommitSourceRef } from "@/lib/identities";

// All non-secret app metadata (signing fields are key ids/paths, never private
// material), so localStorage is the right tier per GL-48.
const LS_PROFILES = "gitlane.profiles:v1";
const LS_PROFILES_LEGACY = "gitlane.profiles";
const LS_COMMIT_SOURCE = "gitlane.repoCommitSource";
// Pre-GL-130 keys, consumed (and deleted) by the one-shot migration below.
const LS_OLD_REPO_PROFILE = "gitlane.repoProfile";
const LS_OLD_CUSTOM_EMAIL = "gitlane.repoProfileEmail";
const LS_REMOVED_CUSTOM_EMAIL = "gitlane.repoCommitEmail";

function readJsonMap(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
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

const profileSchema: z.ZodType<GitProfile> = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  name: z.string().trim().min(1),
  email: z.string().trim().refine(isValidEmail),
  signingKey: z.string().optional(),
  gpgFormat: z.enum(["openpgp", "ssh"]).optional(),
  gpgSign: z.boolean().optional(),
  tagGpgSign: z.boolean().optional(),
  color: z.string(),
  isDefault: z.boolean().optional(),
});

function readManuals(): GitProfile[] {
  try {
    const raw = readMigratedStorage(LS_PROFILES, LS_PROFILES_LEGACY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // localStorage is untrusted input. Keep independently valid cards so one
    // corrupt row cannot crash every identity surface or discard good cards.
    return parsed.flatMap((candidate) => {
      const result = profileSchema.safeParse(candidate);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

function readAppliedMap(): Record<string, CommitSourceRef> {
  const parsed = readJsonMap(LS_COMMIT_SOURCE);
  const valid: Record<string, CommitSourceRef> = {};
  for (const [key, candidate] of Object.entries(parsed)) {
    if (
      key.trim() &&
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as { kind?: unknown }).kind === "manual" &&
      typeof (candidate as { id?: unknown }).id === "string" &&
      (candidate as { id: string }).id.trim()
    ) {
      valid[key] = { kind: "manual", id: (candidate as { id: string }).id.trim() };
    }
  }
  return valid;
}
function writeManuals(manuals: GitProfile[]) {
  try {
    localStorage.setItem(LS_PROFILES, JSON.stringify(manuals));
  } catch {
    /* ignore */
  }
}

/** One-shot value-shape migration from the pre-GL-130 keys. New-key entries
 * win when both exist (a half-migrated state from an interrupted run); the old
 * keys are deleted afterwards so this runs once. */
function migrateLegacyStorage() {
  try {
    const oldApplied = localStorage.getItem(LS_OLD_REPO_PROFILE);
    if (oldApplied) {
      const migrated = migrateAppliedProfileMapSafe(oldApplied);
      const current = readAppliedMap();
      writeJsonMap(LS_COMMIT_SOURCE, { ...migrated, ...current });
      localStorage.removeItem(LS_OLD_REPO_PROFILE);
    }
    const oldEmails = localStorage.getItem(LS_OLD_CUSTOM_EMAIL);
    if (oldEmails) {
      localStorage.removeItem(LS_OLD_CUSTOM_EMAIL);
    }
    localStorage.removeItem(LS_REMOVED_CUSTOM_EMAIL);
  } catch {
    /* malformed legacy data — leave the new keys as-is */
  }
}
function migrateAppliedProfileMapSafe(raw: string): Record<string, CommitSourceRef> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return migrateAppliedProfileMap(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}
/** The open repo's binding key (main checkout path) + its worktree path, for
 * the lazy path→identity key migration. Null when no repo is open. */
function openRepoKeys(): { key: string; path: string } | null {
  const summary = useRepo.getState().summary;
  if (!summary) return null;
  return { key: repoIdentityKey(summary), path: summary.path };
}

function currentPathForIdentity(key: string): string | null {
  const summary = useRepo.getState().summary;
  return summary && repoIdentityKey(summary) === key ? summary.path : null;
}

// Identity writes are multi-key git-config transactions on the backend. Keep
// one write in flight per repository identity so two UI entry points cannot
// interleave different cards. The generation is bumped when intent is
// captured (before queueing), which also prevents a superseded write from
// publishing stale persistence, view state, or success/error toasts.
const identityWriteTails = new Map<string, Promise<void>>();
const latestIdentityWrite = new Map<string, number>();
const activeIdentityIntents = new Map<
  string,
  { generation: number; ref: CommitSourceRef | null }
>();
let identityWriteGeneration = 0;

function nextIdentityWrite(key: string, ref: CommitSourceRef | null): number {
  const generation = ++identityWriteGeneration;
  latestIdentityWrite.set(key, generation);
  activeIdentityIntents.set(key, { generation, ref });
  return generation;
}

function isLatestIdentityWrite(key: string, generation: number): boolean {
  return latestIdentityWrite.get(key) === generation;
}

function invalidateDeletedIdentity(id: string) {
  for (const [key, intent] of activeIdentityIntents) {
    if (intent.ref?.id !== id) continue;
    latestIdentityWrite.set(key, ++identityWriteGeneration);
    // The deleted intent may be queued behind an older write that will still
    // succeed durably. Reconcile after the whole queue drains so invalidating
    // the newer intent cannot leave the in-memory commit identity stale.
    void queueIdentityWrite(key, async () => {
      const currentPath = currentPathForIdentity(key);
      if (currentPath) await useAccounts.getState().hydrateRepoIdentity(currentPath);
    }).catch(() => undefined);
  }
}

function queueIdentityWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
  const previous = identityWriteTails.get(key);
  // Preserve the store's existing immediate-dispatch contract when the queue
  // is idle: calling applyCommitSource starts the IPC before it returns. Only
  // a genuinely overlapping write is deferred behind the prior tail.
  const queued = previous
    ? previous.catch(() => undefined).then(write)
    : Promise.resolve(write());
  const tail = queued.then(
    () => undefined,
    () => undefined,
  );
  identityWriteTails.set(key, tail);
  void tail.finally(() => {
    if (identityWriteTails.get(key) === tail) identityWriteTails.delete(key);
  });
  return queued;
}

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
              useUi.getState().showToast(String(e), "error");
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
        if (isLatestIdentityWrite(key, generation) && currentPathForIdentity(key)) {
          useUi.getState().showToast("This repo commits as this computer's git identity");
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
            useUi.getState().showToast(String(e), "error");
          }
        }
        return false;
      }
      if (outcome === "skipped") return false;
      if (outcome === "deletedAfterWrite") {
        // The external write cannot be canceled once IPC is running. Reconcile
        // the now-unmanaged local identity immediately, but never restore the
        // deleted card's marker or success toast.
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
      if (isLatestIdentityWrite(key, generation) && currentPathForIdentity(key)) {
        useUi.getState().showToast(`This repo commits as ${card.label}`);
      }
      return true;
    } finally {
      if (activeIdentityIntents.get(key)?.generation === generation) {
        activeIdentityIntents.delete(key);
      }
    }
  },

}));
