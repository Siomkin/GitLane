// Runtime schemas for `check_update_on_channel` — mirrors the `UpdateMetadata`
// DTO in `updater.ts` (the Rust `UpdateMetadata` / plugin `UpdateMetadata` shape)
// — and `list_release_notes` (the Rust `ReleaseNotes` DTO).

import { z } from "zod";
import type { ReleaseNotes, UpdateMetadata } from "@/lib/api/updater";
import { assertEqual } from "./assertEqual";

export const updateMetadataSchema = z.object({
  rid: z.number(),
  currentVersion: z.string(),
  version: z.string(),
  // Rust serialises `body: Option<String>` as `null` when the manifest has no
  // release notes; the plugin's own type says `body?: string`, so the wrapper
  // normalises null → undefined before reconstructing the `Update` handle.
  body: z.string().nullish(),
  rawJson: z.record(z.string(), z.unknown()),
});

assertEqual<z.infer<typeof updateMetadataSchema>, UpdateMetadata>(true);

export const releaseNotesSchema = z.object({
  releases: z.array(
    z.object({
      version: z.string(),
      publishedAt: z.string().nullable(),
      body: z.string().nullable(),
    }),
  ),
  hasMore: z.boolean(),
});

assertEqual<z.infer<typeof releaseNotesSchema>, ReleaseNotes>(true);
