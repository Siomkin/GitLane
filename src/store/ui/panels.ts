// Resizable pane and column widths. Every one is a drag-clamped number, so the
// clamps live here beside the field they bound rather than at the call site.
import { persistedKeys, type SliceSet } from "./slice";

export interface PanelWidthsSlice {
  leftWidth: number;
  rightWidth: number;
  /** Graph column width, keyed by normalized repo path. */
  graphWidthsByRepo: Record<string, number>;

  adjustLeftWidth: (dx: number) => void;
  adjustRightWidth: (dx: number) => void;
  setRepoGraphWidth: (repoPath: string, w: number) => void;
}

/** All of them: a width the user dragged is a view preference. */
const PERSISTED = ["leftWidth", "rightWidth", "graphWidthsByRepo"] as const;

export const persistedPanelWidths = (s: PanelWidthsSlice) => persistedKeys(s, PERSISTED);

const clamp = (min: number, max: number, value: number) => Math.max(min, Math.min(max, value));

export function createPanelWidthsSlice(set: SliceSet<PanelWidthsSlice>): PanelWidthsSlice {
  return {
    leftWidth: 300,
    rightWidth: 374,
    graphWidthsByRepo: {},

    adjustLeftWidth: (dx) => set((s) => ({ leftWidth: clamp(200, 460, s.leftWidth + dx) })),
    adjustRightWidth: (dx) => set((s) => ({ rightWidth: clamp(280, 560, s.rightWidth + dx) })),
    setRepoGraphWidth: (repoPath, w) =>
      set((s) => ({
        graphWidthsByRepo: { ...s.graphWidthsByRepo, [repoPath]: clamp(48, 640, w) },
      })),
  };
}
