// Thin wrapper around the Tauri updater/process plugins — the single seam the
// updates store (and its tests) go through, so plugin calls never get scattered
// across components. Everything no-ops outside the Tauri webview (dev server,
// jsdom), where the plugin IPC is unavailable.

import { type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { checkUpdateOnChannel } from "./api/updater";
import { isTauri } from "./platform";

export type { Update, DownloadEvent };

/** Release artifacts opt in at compile time from release.yml. Local/source
 * builds deliberately keep the updater off because their checked-in version is
 * only a baseline and cannot safely represent the source revision being run. */
export const updatesSupported = import.meta.env.VITE_GITLANE_OFFICIAL_RELEASE === "1";

/** Ask the selected channel's endpoint whether a newer signed build exists.
 * `beta` opts into the beta manifest; stable uses the config endpoint (GL-154).
 * Returns the live `Update` handle (call `.downloadAndInstall()` on it) or null
 * when current. Source builds and non-Tauri runtimes have no release updater,
 * so this resolves to null there. */
export async function checkForUpdate(beta: boolean): Promise<Update | null> {
  if (!updatesSupported || !isTauri) return null;
  return checkUpdateOnChannel(beta);
}

/** The running app's version (from tauri.conf.json), for display. */
export async function currentVersion(): Promise<string> {
  if (!isTauri) return "";
  return getVersion();
}

/** Quit and relaunch into the just-installed update. */
export async function relaunchApp(): Promise<void> {
  if (!isTauri) return;
  return relaunch();
}
