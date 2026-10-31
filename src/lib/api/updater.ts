// Raw IPC for the runtime updater-channel check (GL-154). Lives in lib/api so
// the `invoke` boundary holds; the updater *seam* (lib/updater.ts) calls this.
//
// The JS plugin's `check()` can't switch endpoints at runtime, so a Rust
// command (`check_update_on_channel`) rebuilds the updater against the beta
// endpoint when opted in. It returns the plugin's own `UpdateMetadata` shape
// (rid + version fields), which reconstructs a plugin `Update` whose
// download/install reuse the plugin's commands via the parked `rid`.

import { invoke } from "@/lib/api/invoke";
import { releaseNotesSchema, updateMetadataSchema } from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { Update } from "@tauri-apps/plugin-updater";

/** Metadata mirroring the Rust `UpdateMetadata` DTO and the plugin's
 * `UpdateMetadata`; `rid` indexes the live `Update` in the webview resource
 * table so download/install resolve it. `body` is nullable here because the
 * Rust `Option<String>` serialises as `null`; it is normalised to the plugin's
 * `body?: string` before the handle is reconstructed. */
export interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  body?: string | null;
  rawJson: Record<string, unknown>;
}

/** Check for an update on the selected channel. `beta` overrides the endpoint to
 * the beta manifest (stable uses the config endpoint); signature verification
 * stays on either way. Resolves to a plugin `Update` handle, or null when up to
 * date. */
export async function checkUpdateOnChannel(beta: boolean): Promise<Update | null> {
  const meta = parse(
    updateMetadataSchema.nullable(),
    await invoke("check_update_on_channel", { beta }),
    "check_update_on_channel",
  );
  return meta ? new Update({ ...meta, body: meta.body ?? undefined }) : null;
}

/** One release's notes, mirroring the Rust `ReleaseNote` DTO. `body` is markdown
 * with the download-guide line and the unsigned-build footer already removed,
 * or null when nothing is left; `publishedAt` is GitHub's RFC 3339 string. */
export interface ReleaseNote {
  version: string;
  name: string | null;
  publishedAt: string | null;
  body: string | null;
  url: string;
}

/** The releases after the running version, up to and including the offered one,
 * newest first (at most ten). `hasMore` means the range holds more than listed. */
export interface ReleaseNotes {
  releases: ReleaseNote[];
  hasMore: boolean;
}

/** Release notes for `(currentVersion, offeredVersion]` on the selected channel
 * (stable leaves out pre-releases). Rust fetches the public GitHub Releases list. */
export async function listReleaseNotes(
  currentVersion: string,
  offeredVersion: string,
  beta: boolean,
): Promise<ReleaseNotes> {
  return parse(
    releaseNotesSchema,
    await invoke("list_release_notes", { currentVersion, offeredVersion, beta }),
    "list_release_notes",
  );
}
