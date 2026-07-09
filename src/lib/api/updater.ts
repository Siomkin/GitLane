// Raw IPC for the runtime updater-channel check (GL-154). Lives in lib/api so
// the `invoke` boundary holds; the updater *seam* (lib/updater.ts) calls this.
//
// The JS plugin's `check()` can't switch endpoints at runtime, so a Rust
// command (`check_update_on_channel`) rebuilds the updater against the beta
// endpoint when opted in. It returns the plugin's own `UpdateMetadata` shape
// (rid + version fields), which reconstructs a plugin `Update` whose
// download/install reuse the plugin's commands via the parked `rid`.

import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";

/** Metadata mirroring the Rust `UpdateMetadata` DTO and the plugin's
 * `UpdateMetadata`; `rid` indexes the live `Update` in the webview resource
 * table so download/install resolve it. */
interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  body?: string;
  rawJson: Record<string, unknown>;
}

/** Check for an update on the selected channel. `beta` overrides the endpoint to
 * the beta manifest (stable uses the config endpoint); signature verification
 * stays on either way. Resolves to a plugin `Update` handle, or null when up to
 * date. */
export async function checkUpdateOnChannel(beta: boolean): Promise<Update | null> {
  const meta = await invoke<UpdateMetadata | null>("check_update_on_channel", { beta });
  return meta ? new Update(meta) : null;
}
