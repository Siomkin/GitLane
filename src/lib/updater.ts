// Thin wrapper around the Tauri updater/process plugins — the single seam the
// updates store (and its tests) go through, so plugin calls never get scattered
// across components. Everything no-ops outside the Tauri webview (dev server,
// jsdom), where the plugin IPC is unavailable.

import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "./platform";

export type { Update, DownloadEvent };

/** Ask the configured endpoint whether a newer signed build exists. Returns the
 * live `Update` handle (call `.downloadAndInstall()` on it) or null when current.
 * Outside Tauri there is no updater, so this resolves to null. */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri) return null;
  return check();
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
