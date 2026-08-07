// The floating tooltip (e.g. a truncated branch pill's full name).
import type { SliceSet } from "./slice";

export interface TooltipSlice {
  /** Floating tooltip (e.g. full branch name on hover of a truncated pill). */
  tooltip: { text: string; x: number; y: number } | null;

  showTooltip: (text: string, x: number, y: number) => void;
  hideTooltip: () => void;
}

export function createTooltipSlice(set: SliceSet<TooltipSlice>): TooltipSlice {
  return {
    tooltip: null,

    showTooltip: (text, x, y) => set({ tooltip: { text, x, y } }),
    hideTooltip: () => set((s) => (s.tooltip ? { tooltip: null } : s)),
  };
}
