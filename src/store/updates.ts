// In-app update state — the single flow behind the titlebar update indicator and
// the Settings → About "Software update" section. Kept out of `useUi` so update
// churn (download progress) never re-renders unrelated chrome, and isolated from
// git/PR data. All plugin calls go through lib/updater so this stays mockable.

import { create } from "zustand";

import { useUi } from "./ui";
import { checkForUpdate, currentVersion, relaunchApp, updatesSupported, type Update } from "@/lib/updater";

export type UpdateStatus =
  | "idle" // not checked yet this session
  | "checking" // a check is in flight
  | "upToDate" // checked, running the latest build
  | "available" // a newer build exists, not yet downloaded
  | "downloading" // download + install in progress
  | "ready" // installed, pending a relaunch
  | "error"; // the last check/download failed

interface UpdatesState {
  /** True only for signed artifacts produced by the official release workflow. */
  supported: boolean;
  status: UpdateStatus;
  /** Running app version (lazy-loaded for display). */
  version: string;
  /** Version offered by the endpoint, when one is available. */
  newVersion: string | null;
  /** Release notes for the offered update, if any. */
  notes: string | null;
  /** Bytes pulled so far during `downloading`. */
  downloaded: number;
  /** Total download size once the server reports it (null until then). */
  contentLength: number | null;
  /** Last error message (status === "error"). */
  error: string | null;
  /** Live plugin handle for the offered update; held so install can run. */
  update: Update | null;

  loadVersion: () => Promise<void>;
  /** Quiet launch-time policy: populate the version for display, then check the
   * endpoint at most once a day, honoring the About panel's auto-check toggle.
   * Silent on "up to date"/errors (e.g. offline) — only a found update surfaces
   * (the titlebar indicator); the manual flow in Settings → About surfaces the
   * rest. The caller gates on the Tauri runtime (`bun run dev` in a plain
   * browser must not show a bogus state). */
  checkOnLaunch: () => Promise<void>;
  /** Check the endpoint. `quiet` suppresses the up-to-date / error toasts so a
   * startup check stays silent — only a found update surfaces (the indicator). */
  check: (opts?: { quiet?: boolean }) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restart: () => Promise<void>;
}

/** Throttle window for the launch-time auto check (see `checkOnLaunch`). */
const DAY_MS = 24 * 60 * 60 * 1000;

/** True while an update is offered, downloading, or installed-pending-restart —
 * the condition that lights up the titlebar indicator. */
export function hasPendingUpdate(s: UpdatesState): boolean {
  return s.status === "available" || s.status === "downloading" || s.status === "ready";
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  supported: updatesSupported,
  status: "idle",
  version: "",
  newVersion: null,
  notes: null,
  downloaded: 0,
  contentLength: null,
  error: null,
  update: null,

  loadVersion: async () => {
    try {
      const v = await currentVersion();
      if (v && v !== get().version) set({ version: v });
    } catch {
      // Version is display-only; ignore failures (e.g. outside Tauri).
    }
  },

  checkOnLaunch: async () => {
    await get().loadVersion();
    if (!get().supported) return;
    // Channel prefs are read one-shot (never subscribed): `lastUpdateCheckAt`
    // is stamped by `check` itself only when there is nothing to install, so a
    // pending update found before quitting re-surfaces on the next launch.
    const { autoCheckUpdates, lastUpdateCheckAt } = useUi.getState();
    if (autoCheckUpdates && Date.now() - lastUpdateCheckAt >= DAY_MS) {
      await get().check({ quiet: true });
    }
  },

  check: async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!get().supported) return;
    // Don't re-check while busy, and don't clobber a downloaded-pending-restart
    // ("ready") update by resetting it to "checking".
    const status = get().status;
    if (status === "checking" || status === "downloading" || status === "ready") return;
    set({ status: "checking", error: null });
    try {
      // Channel is a persisted UI pref (read one-shot, not subscribed): beta
      // opts into the rolling beta manifest, stable uses the config endpoint
      // (GL-154). Signature verification stays on either way (backend keeps the
      // config pubkey).
      const update = await checkForUpdate(useUi.getState().betaUpdates);
      if (!update) {
        // Stamp the once-a-day throttle (read in App.tsx) ONLY when there is
        // nothing to install. We deliberately do NOT stamp when an update IS
        // available (below): the pending state isn't persisted, so if the user
        // quits before installing, a relaunch must be free to re-check and
        // re-surface it — otherwise the indicator/About card go dark for up to
        // 24h. A failed check doesn't stamp either (it falls through to catch).
        useUi.getState().markUpdateChecked();
        set({ status: "upToDate", update: null, newVersion: null, notes: null });
        if (!quiet) useUi.getState().showToast("GitLane is up to date");
        return;
      }
      set({
        status: "available",
        update,
        newVersion: update.version,
        notes: update.body ?? null,
        downloaded: 0,
        contentLength: null,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Clear any previously-offered handle/metadata: a failed *check* must not
      // leave a stale `update` behind, or the card's retry path (canRetry =
      // error && update !== null) would offer "Retry download" on a dead handle.
      // The download path keeps its handle for retry; the check path does not.
      set({
        status: "error",
        error: message,
        update: null,
        newVersion: null,
        notes: null,
        downloaded: 0,
        contentLength: null,
      });
      if (!quiet) useUi.getState().showToast(`Update check failed: ${message}`, "error");
    }
  },

  downloadAndInstall: async () => {
    const update = get().update;
    if (!update || get().status === "downloading") return;
    set({ status: "downloading", downloaded: 0, contentLength: null, error: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          set({ contentLength: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          set((s) => ({ downloaded: s.downloaded + event.data.chunkLength }));
        }
      });
      set({ status: "ready" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ status: "error", error: message });
      useUi.getState().showToast(`Update failed: ${message}`, "error");
    }
  },

  restart: async () => {
    try {
      await relaunchApp();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      useUi.getState().showToast(`Restart failed: ${message}`, "error");
    }
  },
}));
