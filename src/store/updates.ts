// In-app update state — the single flow behind the titlebar update indicator and
// the Settings → About "Software update" section. Kept out of `useUi` so update
// churn (download progress) never re-renders unrelated chrome, and isolated from
// git/PR data. All plugin calls go through lib/updater so this stays mockable.

import { create } from "zustand";

import { useUi } from "./ui";
import {
  checkForUpdate,
  currentVersion,
  listReleaseNotes,
  relaunchApp,
  updatesSupported,
  type ReleaseNotes,
  type Update,
} from "@/lib/updater";

export type UpdateStatus =
  | "idle" // not checked yet this session
  | "checking" // a check is in flight
  | "upToDate" // checked, running the latest build
  | "available" // a newer build exists, not yet downloaded
  | "downloading" // download + install in progress
  | "ready" // installed, pending a relaunch
  | "error"; // the last check/download failed

/** The What's new notes for one offered version. Kept apart from `status` /
 * `error`: notes failing to load never fails a check or an install. */
export interface ReleaseNotesState {
  forVersion: string;
  /** The running version and channel the notes were fetched for (the cache key with `forVersion`). */
  from: string;
  beta: boolean;
  state: "loading" | "loaded" | "error";
  data: ReleaseNotes | null;
}

interface UpdatesState {
  /** True only for signed artifacts produced by the official release workflow. */
  supported: boolean;
  status: UpdateStatus;
  /** Running app version (lazy-loaded for display). */
  version: string;
  /** Version offered by the endpoint, when one is available. */
  newVersion: string | null;
  /** GitHub release notes for the offered version, loaded lazily by the views. */
  releaseNotes: ReleaseNotesState | null;
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
  /** Check the endpoint. `quiet` suppresses error toasts on startup checks;
   * up-to-date is always silent — only a found update surfaces (the indicator).
   * `launch` marks the automatic launch check, the only one that stays silent
   * about the version the user skipped. */
  check: (opts?: { quiet?: boolean; launch?: boolean }) => Promise<void>;
  /** Skip the offered version: the launch check stays silent about it from now
   * on. Only while an update is offered, never mid-download or once installed. */
  skip: () => Promise<void>;
  /** Fetch the release notes for the offered version, once per version (a
   * failed load may retry). Called by the What's new dialog and the About card. */
  loadReleaseNotes: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restart: () => Promise<void>;
}

/** Throttle window for the launch-time auto check (see `checkOnLaunch`). */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Free a plugin `Update` handle that is being dropped, so its webview resource
 * doesn't outlive it. Best effort: a failed close changes nothing the user sees. */
async function release(update: Update | null): Promise<void> {
  try {
    await update?.close();
  } catch {
    // Already gone, or outside Tauri.
  }
}

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
  releaseNotes: null,
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
      await get().check({ quiet: true, launch: true });
    }
  },

  check: async ({ quiet = false, launch = false }: { quiet?: boolean; launch?: boolean } = {}) => {
    if (!get().supported) return;
    // Don't re-check while busy, and don't clobber a downloaded-pending-restart
    // ("ready") update by resetting it to "checking".
    const status = get().status;
    if (status === "checking" || status === "downloading" || status === "ready") return;
    // Whatever this check settles on, a handle it replaces is freed (below).
    const previous = get().update;
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
        set({ status: "upToDate", update: null, newVersion: null });
        return;
      }
      // The launch check stays silent about the version the user skipped, and
      // counts it as nothing to install for the daily throttle. `idle`, not
      // `upToDate`: the About card must not claim this is the latest build. Any
      // check the user starts (the button, a channel switch) offers it as usual.
      if (launch && update.version === useUi.getState().skippedUpdateVersion) {
        useUi.getState().markUpdateChecked();
        set({ status: "idle", update: null, newVersion: null });
        await release(update);
        return;
      }
      set({
        status: "available",
        update,
        newVersion: update.version,
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
        downloaded: 0,
        contentLength: null,
      });
      if (!quiet) useUi.getState().showToast(`Update check failed: ${message}`, "error");
    } finally {
      if (previous !== get().update) await release(previous);
    }
  },

  skip: async () => {
    const { status, newVersion, update } = get();
    if (status !== "available" || !newVersion) return;
    useUi.getState().setSkippedUpdateVersion(newVersion);
    useUi.getState().closeWhatsNew();
    set({ status: "idle", update: null, newVersion: null });
    await release(update);
  },

  loadReleaseNotes: async () => {
    const { newVersion, releaseNotes, update, version } = get();
    // The handle knows the version it updates from; `version` covers the rest.
    const from = update?.currentVersion || version;
    if (!newVersion || !from) return;
    const beta = useUi.getState().betaUpdates;
    const key = { forVersion: newVersion, from, beta };
    const sameKey = (n: ReleaseNotesState | null) =>
      n?.forVersion === newVersion && n.from === from && n.beta === beta;
    if (sameKey(releaseNotes) && releaseNotes?.state !== "error") return;
    set({ releaseNotes: { ...key, state: "loading", data: null } });
    let next: ReleaseNotesState;
    try {
      next = { ...key, state: "loaded", data: await listReleaseNotes(from, newVersion, beta) };
    } catch {
      next = { ...key, state: "error", data: null };
    }
    // A late answer for a version, base or channel no longer current is dropped.
    if (sameKey(get().releaseNotes)) set({ releaseNotes: next });
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
