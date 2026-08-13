// Shared editor engine for the settings panels that persist per row (AI Agents,
// Prompts): `useDraftState`'s working copy plus a `persistNow` that coalesces
// writes behind an in-flight one and flushes on unmount. The panels differ only
// in *what* is persistable, which they pass in as `build`. A panel with a
// page-level Save wants `useDraftState` alone — the unmount flush here would
// turn "navigate away" into "save".

import { useEffect, useRef, useState } from "react";
import { type DraftState, useDraftState } from "@/hooks/useDraftState";
import { useUi } from "@/store/ui";

export interface DraftPersist<T> extends DraftState<T> {
  /** Last-saved value, readable synchronously inside event handlers. */
  savedRef: React.RefObject<T>;
  saving: boolean;
  /** Write the draft to disk. `saveId` is the one row whose in-progress edit is
   *  being saved — every *other* open editor still falls back to what is on
   *  disk, so saving one row cannot commit a half-typed value in another.
   *  Resolves false when nothing was written and the caller should keep its
   *  editor open: a rejected write, or a draft that fails validation. */
  persistNow: (saveId?: string) => Promise<boolean>;
  /** Stable handle to the latest `persistNow` — for callbacks that outlive the
   *  render that created them (confirm dialogs, unmount). */
  persistNowRef: React.RefObject<(saveId?: string) => Promise<boolean>>;
}

export function useDraftPersist<T>(
  saved: T,
  signature: (value: T) => string,
  /** The value that should hit disk, or null to refuse the write. */
  build: (draft: T, saved: T, saveId?: string) => T | null,
  save: (value: T) => Promise<void>,
): DraftPersist<T> {
  const showToast = useUi((s) => s.showToast);
  const state = useDraftState(saved, signature);
  const { draftRef } = state;
  const [saving, setSaving] = useState(false);

  const savedRef = useRef(saved);
  savedRef.current = saved;
  const savingRef = useRef(false);
  const persistAgain = useRef(false);
  const persistAgainSaveId = useRef<string | null>(null);
  const persistNowRef = useRef<(saveId?: string) => Promise<boolean>>(async () => true);

  const persistNow = async (saveId?: string): Promise<boolean> => {
    const next = build(draftRef.current, savedRef.current, saveId);
    if (!next) return false;
    if (signature(next) === signature(savedRef.current)) return true;
    if (savingRef.current) {
      // Coalesced behind an in-flight write; that run carries this row's id and
      // does the work, so the editor may close.
      persistAgain.current = true;
      persistAgainSaveId.current ??= saveId ?? null;
      return true;
    }
    savingRef.current = true;
    setSaving(true);
    let ok = true;
    try {
      await save(next);
    } catch (e) {
      ok = false;
      showToast(String(e instanceof Error ? e.message : e), "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (persistAgain.current) {
        persistAgain.current = false;
        const again = persistAgainSaveId.current ?? undefined;
        persistAgainSaveId.current = null;
        void persistNowRef.current(again);
      }
    }
    return ok;
  };
  persistNowRef.current = persistNow;

  useEffect(() => () => void persistNowRef.current(), []);

  return { ...state, savedRef, saving, persistNow, persistNowRef };
}
