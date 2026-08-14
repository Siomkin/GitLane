// The editable working copy every settings panel keeps in front of its store:
// a `draft` that adopts a fresh backend value only while it is *pristine*, so a
// background reload — another mount re-probing availability, a watcher re-read —
// can never discard the user's unsaved edits.

import { useRef, useState } from "react";

export interface DraftState<T> {
  draft: T;
  /** Latest draft, readable synchronously inside event handlers. */
  draftRef: React.RefObject<T>;
  /** Apply an update to the draft and return the new value. */
  apply: (updater: (current: T) => T) => T;
  /** Force-adopt a value even when the draft is dirty — for an explicit,
   *  confirmed action such as Reset, where pristine-only adoption would leave
   *  the stale edits in place and the button would appear to do nothing. */
  adopt: (value: T) => void;
}

export function useDraftState<T>(saved: T, signature: (value: T) => string): DraftState<T> {
  const [draft, setDraft] = useState<T>(saved);
  // Adjust during render (architecture-rules-react.md §1) rather than syncing in
  // an effect: no extra paint of the stale list, and no ordering trap around
  // when the baseline is reassigned.
  const [baselineSig, setBaselineSig] = useState(() => signature(saved));
  const savedSig = signature(saved);
  if (savedSig !== baselineSig) {
    setBaselineSig(savedSig);
    if (signature(draft) === baselineSig) setDraft(saved);
  }

  const draftRef = useRef(draft);
  draftRef.current = draft;

  const apply = (updater: (current: T) => T): T => {
    const next = updater(draftRef.current);
    draftRef.current = next;
    setDraft(next);
    return next;
  };

  const adopt = (value: T) => {
    draftRef.current = value;
    setDraft(value);
    setBaselineSig(signature(value));
  };

  return { draft, draftRef, apply, adopt };
}
