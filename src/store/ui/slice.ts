// How the `ui` store is composed (GL-357).
//
// `ui.ts` grew to a 199-member interface across 18 concerns. Six of them —
// theme, panel widths, update/auto-fetch preferences, history search, the graph
// text filter, the tooltip — touch nothing else in the file: delete any one and
// the rest does not notice. The remaining twelve were entangled by one field,
// `menu`, which the actions that open something else all clear; a slice that
// writes it now declares that in its own `set` type. Every concern lives in
// this folder, composed back into `ui.ts` the same way `repo.ts` composes its
// action slices.
//
// The slice contract itself is shared with the other composed stores — see
// `store/slice.ts`.

export { persistedKeys, type SliceSet } from "@/store/slice";
