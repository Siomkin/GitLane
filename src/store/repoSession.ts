// Session persistence for the repo store: which repos are open (the tab strip)
// and which was active last, mirrored to localStorage so the app reopens them on
// launch. Pure storage helpers — no Zustand, no IPC (selection.ts-style module).

import { repoLabel } from "../lib/paths";

const LS_OPEN = "gitlane.openPaths";
const LS_LAST = "gitlane.lastPath";
const LS_RECENTS = "gitlane.recentRepos";

/** Max recent repositories kept (the onboarding "Recent" list is short). */
const RECENTS_LIMIT = 12;

/** A previously-opened repository shown on the onboarding screen, most-recent
 * first. `branch`/`missing` are refreshed from disk on the start screen; only
 * the durable fields are persisted (`missing` is recomputed, never stored). */
export interface RecentRepo {
  path: string;
  name: string;
  branch: string | null;
  /** Epoch ms of the last open, for the relative "when" label + ordering. */
  lastOpenedAt: number;
  /** Runtime-only: true when the path no longer resolves on disk. */
  missing?: boolean;
}

/** Open-repo paths persisted from a previous session (the tab strip). */
export function readOpenPaths(): string[] {
  try {
    const raw = localStorage.getItem(LS_OPEN);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Path of the last active repo, reopened on launch (null when none/unavailable). */
export function readLastPath(): string | null {
  try {
    return localStorage.getItem(LS_LAST);
  } catch {
    return null;
  }
}

/** Mirror the open set + active repo to localStorage. */
export function persistSession(openPaths: string[], lastPath: string | null): void {
  try {
    localStorage.setItem(LS_OPEN, JSON.stringify(openPaths));
    if (lastPath) localStorage.setItem(LS_LAST, lastPath);
    else localStorage.removeItem(LS_LAST);
  } catch {
    /* ignore quota / unavailable */
  }
}

/** Recently-opened repositories from a previous session (most-recent first). */
export function readRecents(): RecentRepo[] {
  try {
    const raw = localStorage.getItem(LS_RECENTS);
    // Absent key → first run on a version with recents: migrate from the old
    // open-tabs list so existing users don't see an empty Recent panel after
    // upgrading. A present (even empty "[]") value is authoritative — no remigrate.
    if (raw === null) return migrateRecentsFromOpenPaths();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is RecentRepo => !!r && typeof r.path === "string")
      .map((r) => ({
        path: r.path,
        name: typeof r.name === "string" ? r.name : r.path,
        branch: typeof r.branch === "string" ? r.branch : null,
        lastOpenedAt: typeof r.lastOpenedAt === "number" ? r.lastOpenedAt : 0,
      }));
  } catch {
    return [];
  }
}

/** One-time upgrade seed: derive recents from the persisted open-tabs list (what
 * the old welcome screen used as "recent"). No timestamps existed, so order by
 * the tab list most-recent-first and leave `lastOpenedAt` at 0; the first real
 * open will refine + persist the list. */
function migrateRecentsFromOpenPaths(): RecentRepo[] {
  try {
    const raw = localStorage.getItem(LS_OPEN);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is string => typeof p === "string")
      .reverse()
      .slice(0, RECENTS_LIMIT)
      .map((path) => ({ path, name: repoLabel(path), branch: null, lastOpenedAt: 0 }));
  } catch {
    return [];
  }
}

/** Mirror the recent list to localStorage (durable fields only — `missing` is a
 * runtime flag recomputed each launch). */
export function persistRecents(recents: RecentRepo[]): void {
  try {
    const durable = recents
      .slice(0, RECENTS_LIMIT)
      .map(({ path, name, branch, lastOpenedAt }) => ({ path, name, branch, lastOpenedAt }));
    localStorage.setItem(LS_RECENTS, JSON.stringify(durable));
  } catch {
    /* ignore quota / unavailable */
  }
}

/** Move/insert `entry` at the front of the recent list (dedup by path), capped. */
export function upsertRecent(recents: RecentRepo[], entry: RecentRepo): RecentRepo[] {
  const rest = recents.filter((r) => r.path !== entry.path);
  return [entry, ...rest].slice(0, RECENTS_LIMIT);
}
