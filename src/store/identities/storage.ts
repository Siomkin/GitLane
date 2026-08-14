// Where identity cards and their per-repo application live in localStorage,
// and the migrations that carry the older key shapes forward.

import { z } from "zod";

import { migrateAppliedProfileMap, type CommitSourceRef } from "@/lib/identities";
import { isValidEmail, type GitProfile } from "@/lib/profiles";
import { readMigratedStorage } from "@/lib/storage";
import { repoIdentityKey } from "@/lib/worktrees";
import { useRepo } from "@/store/repo";

// All non-secret app metadata (signing fields are key ids/paths, never private
// material), so localStorage is the right tier per GL-48.
export const LS_PROFILES = "gitlane.profiles:v1";
export const LS_PROFILES_LEGACY = "gitlane.profiles";
export const LS_COMMIT_SOURCE = "gitlane.repoCommitSource";
// Pre-GL-130 keys, consumed (and deleted) by the one-shot migration below.
export const LS_OLD_REPO_PROFILE = "gitlane.repoProfile";
export const LS_OLD_CUSTOM_EMAIL = "gitlane.repoProfileEmail";
export const LS_REMOVED_CUSTOM_EMAIL = "gitlane.repoCommitEmail";

export function readJsonMap(key: string): Record<string, unknown> {
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
export function writeJsonMap<T>(key: string, map: Record<string, T>) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* ignore quota / unavailable */
  }
}

export const profileSchema: z.ZodType<GitProfile> = z.object({
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

export function readManuals(): GitProfile[] {
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

export function readAppliedMap(): Record<string, CommitSourceRef> {
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
export function writeManuals(manuals: GitProfile[]) {
  try {
    localStorage.setItem(LS_PROFILES, JSON.stringify(manuals));
  } catch {
    /* ignore */
  }
}

/** One-shot value-shape migration from the pre-GL-130 keys. New-key entries
 * win when both exist (a half-migrated state from an interrupted run); the old
 * keys are deleted afterwards so this runs once. */
export function migrateLegacyStorage() {
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
export function migrateAppliedProfileMapSafe(raw: string): Record<string, CommitSourceRef> {
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
export function openRepoKeys(): { key: string; path: string } | null {
  const summary = useRepo.getState().summary;
  if (!summary) return null;
  return { key: repoIdentityKey(summary), path: summary.path };
}

export function currentPathForIdentity(key: string): string | null {
  const summary = useRepo.getState().summary;
  return summary && repoIdentityKey(summary) === key ? summary.path : null;
}
