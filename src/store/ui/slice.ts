// The shape a `ui` slice takes (GL-357).
//
// `ui.ts` grew to a 199-member interface across 18 concerns. Six of them —
// theme, panel widths, update/auto-fetch preferences, history search, the graph
// text filter, the tooltip — touch nothing else in the file: delete any one and
// the rest does not notice. Those live in this folder now, composed back into
// `ui.ts` the same way `repo.ts` composes its eight action slices.
//
// A slice owns three things and no more: its state (declared once), the actions
// that write it, and — where it has any — the keys it persists and the reset a
// repo switch needs. Nothing here reaches into another slice or another store;
// the moment one does, it belongs back in `ui.ts` where the coupling is visible.

/** The `set` a slice creator needs. Narrower than the store's own — a slice only
 * ever writes its own fields, and the type says so. */
export type SliceSet<T> = (partial: Partial<T> | ((state: T) => Partial<T>)) => void;

/** The subset of `state` a slice persists. Keeps `partialize` a composition of
 * per-slice key lists rather than one flat list that drifts from its state. */
export function persistedKeys<T, K extends keyof T>(state: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = state[key];
  return out;
}
