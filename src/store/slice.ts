// The shape a store slice takes, shared by the stores that compose one
// (`ui/`, `accounts/`).
//
// A slice owns three things and no more: its state (declared once), the actions
// that write it, and — where it has any — the keys it persists and the reset a
// repo switch needs. A slice that must write another slice's field says so in
// its own `set` type (`SliceSet<OwnSlice & Pick<OtherSlice, "field">>`), so the
// coupling is declared at the point that depends on it rather than hidden in a
// shared scope.

/** The `set` a slice creator needs. Narrower than the store's own — it names
 * exactly the fields the slice writes, and the type enforces it. */
export type SliceSet<T> = (partial: Partial<T> | ((state: T) => Partial<T>)) => void;

/** The subset of `state` a slice persists. Keeps `partialize` a composition of
 * per-slice key lists rather than one flat list that drifts from its state. */
export function persistedKeys<T, K extends keyof T>(state: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = state[key];
  return out;
}
