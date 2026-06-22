// Account chip palette — a fixed cycle assigned to gh accounts by index. Kept
// separate from features/graph/palette.ts on purpose: the graph's lane-color
// cycle is ordered to match the Rust `color` index and must not be conflated
// with this UI-only account palette.
export const ACCOUNT_COLORS = ["#5b8def", "#c875d6", "#2f9e7e", "#e0843b", "#48b9c7"];
