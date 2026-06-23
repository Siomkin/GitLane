// Session persistence for the repo store: which repos are open (the tab strip)
// and which was active last, mirrored to localStorage so the app reopens them on
// launch. Pure storage helpers — no Zustand, no IPC (selection.ts-style module).

const LS_OPEN = "gitlane.openPaths";
const LS_LAST = "gitlane.lastPath";

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
